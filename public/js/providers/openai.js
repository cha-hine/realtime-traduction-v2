import { SentenceStreamer } from "../transcript.js";

/**
 * Fournisseurs OpenAI (WebRTC).
 *  - "translate" : gpt-realtime-translate, traduction continue sans attendre les pauses
 *  - "realtime"  : gpt-realtime-2.1 + instructions personnalisées, une traduction par segment
 *
 * Interface commune à tous les fournisseurs :
 *   connect() → Promise (résolue quand la traduction est prête)
 *   detachAudio()  : coupe l'envoi du micro (rotation de session sans doublon)
 *   replaceTrack(track) : changement de micro à chaud
 *   updateVad(vad) : réglages VAD en direct (si supporté)
 *   close()
 */

const CONNECT_TIMEOUT_MS = 15000;
const CONTEXT_ITEMS = 6; // traductions précédentes données comme contexte

export function buildTurnDetection(vad) {
  const common = { create_response: false, interrupt_response: false };
  return vad.mode === "server"
    ? {
        type: "server_vad",
        threshold: vad.threshold,
        prefix_padding_ms: vad.prefixMs,
        silence_duration_ms: vad.silenceMs,
        ...common,
      }
    : { type: "semantic_vad", eagerness: vad.eagerness, ...common };
}

class OpenAIWebRTC {
  constructor(mode, ctx) {
    this.mode = mode;
    this.ctx = ctx; // { mic, transcript, settings, onSpeech, onLatency, onError, onClosed }
    this.pc = null;
    this.dc = null;
    this.sender = null;
    this.closing = false;
    this.closedNotified = false;
  }

  async connect() {
    const { mic, settings } = this.ctx;
    const pc = (this.pc = new RTCPeerConnection());
    this.sender = pc.addTrack(mic.track, mic.stream);
    pc.ontrack = () => {}; // l'audio traduit n'est pas joué : seul le texte nous intéresse

    const dc = (this.dc = pc.createDataChannel("oai-events"));
    dc.onmessage = (e) => {
      try {
        this.handleEvent(JSON.parse(e.data));
      } catch (err) {
        console.error("Événement illisible", err, e.data);
      }
    };
    dc.onclose = () => this.notifyClosed("canal de données fermé");

    let disconnectTimer = null;
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      clearTimeout(disconnectTimer);
      if (state === "failed") this.notifyClosed("connexion WebRTC échouée");
      // "disconnected" peut se rétablir seul : on laisse 3 s avant de reconnecter.
      if (state === "disconnected") {
        disconnectTimer = setTimeout(() => this.notifyClosed("connexion WebRTC perdue"), 3000);
      }
    };

    const opened = new Promise((resolve, reject) => {
      dc.addEventListener("open", resolve, { once: true });
      setTimeout(() => reject(new Error("Délai de connexion dépassé")), CONNECT_TIMEOUT_MS);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch("/session/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp, mode: this.mode, settings }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
    await opened;
  }

  send(event) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  detachAudio() {
    this.sender?.replaceTrack(null);
  }

  replaceTrack(track) {
    return this.sender?.replaceTrack(track);
  }

  notifyClosed(reason) {
    if (this.closing || this.closedNotified) return;
    this.closedNotified = true;
    this.ctx.onClosed(reason);
  }

  handleError(error) {
    const code = error?.code || "";
    const message = error?.message || JSON.stringify(error);
    console.error("❌ OpenAI:", error);
    const rateLimit = code === "rate_limit_exceeded" || /rate.?limit|too many requests/i.test(message);
    this.ctx.onError(message, { rateLimit });
  }

  close() {
    this.closing = true;
    this.dc?.close();
    this.pc?.close();
    this.dc = this.pc = this.sender = null;
  }
}

/** gpt-realtime-2.1 : une réponse hors conversation par segment détecté (VAD). */
class OpenAIRealtime extends OpenAIWebRTC {
  constructor(ctx) {
    super("realtime", ctx);
    this.requests = new Map(); // request_id → { segId, itemId, committedAt, firstDelta }
    this.byResponse = new Map(); // response.id → request
    this.seq = 0;
  }

  handleEvent(msg) {
    const { transcript } = this.ctx;

    switch (msg.type) {
      case "input_audio_buffer.speech_started":
        this.ctx.onSpeech(true);
        break;

      case "input_audio_buffer.speech_stopped":
        this.ctx.onSpeech(false);
        break;

      case "input_audio_buffer.committed": {
        // Chaque segment est traduit tout de suite, même si le précédent n'est pas fini :
        // les réponses tournent en parallèle et s'affichent dans l'ordre de parole.
        const requestId = `req_${++this.seq}`;
        const request = {
          segId: transcript.begin(),
          itemId: msg.item_id,
          committedAt: performance.now(),
          firstDelta: true,
        };
        this.requests.set(requestId, request);

        const input = [];
        const context = transcript.recentFinals(CONTEXT_ITEMS);
        if (context.length) {
          input.push({
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Contexte déjà traduit (ne pas répéter) :\n${context.join("\n")}`,
              },
            ],
          });
        }
        input.push({ type: "item_reference", id: msg.item_id });

        this.send({
          type: "response.create",
          response: {
            conversation: "none",
            output_modalities: ["text"],
            metadata: { request_id: requestId },
            input,
          },
        });
        break;
      }

      case "response.created": {
        const request = this.requests.get(msg.response?.metadata?.request_id);
        if (request) this.byResponse.set(msg.response.id, request);
        break;
      }

      case "response.output_text.delta":
      case "response.text.delta": {
        const request = this.byResponse.get(msg.response_id);
        if (!request) break;
        if (request.firstDelta) {
          request.firstDelta = false;
          this.ctx.onLatency(performance.now() - request.committedAt);
        }
        transcript.append(request.segId, msg.delta);
        break;
      }

      case "response.output_text.done":
      case "response.text.done": {
        const request = this.byResponse.get(msg.response_id);
        if (request && msg.text) transcript.set(request.segId, msg.text);
        break;
      }

      case "response.done": {
        const id = msg.response?.id;
        const request = this.byResponse.get(id);
        if (!request) break;
        transcript.finalize(request.segId);
        this.byResponse.delete(id);
        this.requests.delete(msg.response.metadata?.request_id);
        if (msg.response.status === "failed") {
          this.handleError(msg.response.status_details?.error || { message: "Réponse échouée" });
        }
        // Le segment audio est traduit : on le retire de la session (session légère).
        this.send({ type: "conversation.item.delete", item_id: request.itemId });
        break;
      }

      case "error":
        if (msg.error?.code === "item_not_found" || /item.*not found/i.test(msg.error?.message || "")) break;
        this.handleError(msg.error);
        break;
    }
  }

  updateVad(vad) {
    this.send({
      type: "session.update",
      session: { type: "realtime", audio: { input: { turn_detection: buildTurnDetection(vad) } } },
    });
  }

  close() {
    for (const request of this.requests.values()) this.ctx.transcript.finalize(request.segId);
    super.close();
  }
}

/** gpt-realtime-translate : flux continu de texte traduit, découpé en phrases. */
class OpenAITranslate extends OpenAIWebRTC {
  constructor(ctx) {
    super("translate", ctx);
    this.streamer = new SentenceStreamer(ctx.transcript);
  }

  handleEvent(msg) {
    switch (msg.type) {
      case "session.output_transcript.delta":
        this.streamer.push(msg.delta);
        break;
      case "session.closed":
        this.streamer.flush();
        break;
      case "error":
        this.handleError(msg.error);
        break;
    }
  }

  close() {
    this.streamer.flush();
    super.close();
  }
}

export const createOpenAIRealtime = (ctx) => new OpenAIRealtime(ctx);
export const createOpenAITranslate = (ctx) => new OpenAITranslate(ctx);
