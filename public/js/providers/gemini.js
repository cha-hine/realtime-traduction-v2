import { SentenceStreamer } from "../transcript.js";

/**
 * Gemini Live via le relais WebSocket du serveur (/gemini).
 * Google ne propose pas de WebRTC natif pour Gemini Live : le relais local
 * ajoute ~1 ms et garde la clé API hors du navigateur.
 */
const CONNECT_TIMEOUT_MS = 15000;

class GeminiLive {
  constructor(ctx) {
    this.ctx = ctx; // { mic, transcript, settings, onStatus, onError, onClosed }
    this.ws = null;
    this.streamer = new SentenceStreamer(ctx.transcript);
    this.closing = false;
    this.closedNotified = false;
    this.sending = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = (this.ws = new WebSocket(`${proto}//${location.host}/gemini`));
      ws.binaryType = "arraybuffer";
      let ready = false;
      const timer = setTimeout(() => reject(new Error("Délai de connexion Gemini dépassé")), CONNECT_TIMEOUT_MS);

      ws.onopen = async () => {
        ws.send(JSON.stringify({ type: "start", settings: this.ctx.settings }));
        // Le micro part tout de suite : le serveur met l'audio en tampon pendant la configuration.
        this.sending = true;
        await this.ctx.mic.startPcm((chunk) => {
          if (this.sending && ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case "ready":
            if (!ready) {
              ready = true;
              clearTimeout(timer);
              resolve();
            }
            this.ctx.onStatus?.(`Gemini prêt (${msg.model})`);
            break;
          case "delta":
            this.streamer.push(msg.text);
            break;
          case "turn_complete":
            this.streamer.flush();
            break;
          case "reconnecting":
            this.ctx.onStatus?.("Gemini : reprise de session…");
            break;
          case "error":
            clearTimeout(timer);
            if (!ready) reject(new Error(msg.message));
            else this.ctx.onError(msg.message, { fatal: true });
            break;
        }
      };

      ws.onclose = () => {
        clearTimeout(timer);
        this.streamer.flush();
        if (!ready) reject(new Error("Connexion Gemini fermée"));
        else if (!this.closing && !this.closedNotified) {
          this.closedNotified = true;
          this.ctx.onClosed("relais Gemini fermé");
        }
      };
    });
  }

  detachAudio() {
    this.sending = false;
  }

  replaceTrack() {
    // Le micro alimente directement l'AudioWorklet : rien à faire ici.
  }

  close() {
    this.closing = true;
    this.sending = false;
    this.streamer.flush();
    this.ws?.close();
    this.ws = null;
  }
}

export const createGemini = (ctx) => new GeminiLive(ctx);
