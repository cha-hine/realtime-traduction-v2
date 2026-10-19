import { WebSocket, WebSocketServer } from "ws";
import { normalizeSettings } from "./settings.js";

// Relais WebSocket navigateur ⇄ Gemini Live.
// - la clé API reste sur le serveur
// - 1er message du navigateur (texte JSON) : { type: "start", settings } avec les instructions
// - ensuite le navigateur envoie du PCM16 16 kHz brut (binaire), le serveur l'emballe en base64
// - l'audio de sortie Gemini est filtré : seul le texte redescend au navigateur
// - les coupures programmées par Google (goAway) sont reprises de façon transparente
//   grâce à sessionResumption, sans perdre l'audio (mis en tampon)

const GEMINI_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-live";
// Les modèles "native audio" n'acceptent que AUDIO : le texte vient alors de outputAudioTranscription.
const RESPONSE_MODALITY = (process.env.GEMINI_RESPONSE_MODALITY || "AUDIO").toUpperCase();

const MAX_BUFFERED_CHUNKS = 400; // ~20 s d'audio (morceaux de 50 ms) pendant une reconnexion
const MAX_RECONNECTS = 5;

function buildSetup(settings, handle) {
  const { vad } = settings;
  const setup = {
    model: `models/${GEMINI_MODEL}`,
    generationConfig: { responseModalities: [RESPONSE_MODALITY], temperature: 0.3 },
    systemInstruction: { parts: [{ text: settings.instructions }] },
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
        endOfSpeechSensitivity:
          vad.eagerness === "low" ? "END_SENSITIVITY_LOW" : "END_SENSITIVITY_HIGH",
        prefixPaddingMs: vad.prefixMs,
        silenceDurationMs: vad.silenceMs,
      },
      // Indispensable pour un sermon continu : sinon chaque reprise de parole
      // coupe la traduction en cours.
      activityHandling: "NO_INTERRUPTION",
    },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: handle ? { handle } : {},
  };
  if (RESPONSE_MODALITY === "AUDIO") setup.outputAudioTranscription = {};
  return { setup };
}

export function attachGeminiProxy(server, { isAllowedOrigin }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/gemini" || !isAllowedOrigin(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, handleClient);
  });
}

function handleClient(client) {
  const apiKey = process.env.GEMINI_API_KEY;
  const send = (obj) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));

  if (!apiKey) {
    send({ type: "error", message: "GEMINI_API_KEY non configurée dans .env" });
    return client.close();
  }

  let settings = null;
  let upstream = null; // connexion qui reçoit l'audio
  let ready = false;
  let resumeHandle = null;
  let closed = false;
  let reconnects = 0;
  const pending = [];

  const sendAudio = (ws, chunk) =>
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: chunk.toString("base64") },
        },
      }),
    );

  function connect() {
    const ws = new WebSocket(`${GEMINI_WS}?key=${encodeURIComponent(apiKey)}`);
    let replaced = false;
    if (!upstream) upstream = ws;

    ws.on("open", () => ws.send(JSON.stringify(buildSetup(settings, resumeHandle))));

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.setupComplete) {
        const previous = upstream;
        upstream = ws;
        ready = true;
        reconnects = 0;
        while (pending.length) sendAudio(ws, pending.shift());
        if (previous && previous !== ws) {
          // L'ancienne connexion termine sa phrase en cours puis est fermée.
          previous.retired = true;
          setTimeout(() => previous.close(), 4000);
        }
        send({ type: "ready", model: GEMINI_MODEL });
        return;
      }

      if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
        resumeHandle = msg.sessionResumptionUpdate.newHandle;
      }

      if (msg.goAway && !replaced && ws === upstream) {
        replaced = true;
        console.log("♻️  Gemini goAway → reprise de session", msg.goAway.timeLeft || "");
        connect();
      }

      const content = msg.serverContent;
      if (content) {
        const text =
          content.outputTranscription?.text ||
          (RESPONSE_MODALITY === "TEXT"
            ? (content.modelTurn?.parts || [])
                .filter((p) => p.text && !p.thought)
                .map((p) => p.text)
                .join("")
            : "");
        if (text) send({ type: "delta", text });
        if (content.turnComplete) send({ type: "turn_complete" });
      }
    });

    ws.on("close", (code, reason) => {
      if (closed || ws.retired) return;
      const why = reason?.toString() || `code ${code}`;
      if (ws !== upstream) {
        // Connexion de remplacement qui a échoué avant setupComplete → nouvel essai.
        if (reconnects++ < MAX_RECONNECTS) setTimeout(connect, 500);
        return;
      }
      ready = false; // l'audio est mis en tampon jusqu'à la prochaine connexion prête
      if (replaced) return; // ancienne connexion retirée après goAway, le remplaçant arrive
      console.warn("⚠️  Gemini fermé:", why);
      // 1007/1008 = configuration refusée (modèle, clé, instructions…) : inutile de réessayer
      if (code === 1007 || code === 1008 || reconnects >= MAX_RECONNECTS) {
        send({ type: "error", message: `Gemini: ${why}` });
        return client.close();
      }
      reconnects += 1;
      send({ type: "reconnecting" });
      upstream = null;
      setTimeout(connect, Math.min(4000, 500 * 2 ** reconnects));
    });

    // Une erreur est toujours suivie d'un "close" : la reprise est gérée là-bas.
    ws.on("error", (err) => console.error("❌ Gemini WS:", err.message));
  }

  client.on("message", (data, isBinary) => {
    if (!isBinary) {
      // Message de démarrage avec les réglages et les instructions.
      if (settings) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "start") return;
        settings = normalizeSettings(msg.settings);
      } catch {
        send({ type: "error", message: "Message de démarrage invalide" });
        return client.close();
      }
      connect();
      return;
    }
    const chunk = Buffer.from(data);
    if (ready && upstream?.readyState === WebSocket.OPEN) {
      sendAudio(upstream, chunk);
    } else {
      pending.push(chunk);
      if (pending.length > MAX_BUFFERED_CHUNKS) pending.shift();
    }
  });

  client.on("close", () => {
    closed = true;
    upstream?.close();
  });
}
