/**
 * Micro unique pour toute la durée de la traduction : il survit aux
 * reconnexions et rotations de session (plus de flux ni d'AudioContext qui fuient).
 */
export class Mic {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel;
    this.stream = null;
    this.track = null;
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.worklet = null;
    this.pcmCallback = null;
    this.raf = null;
  }

  async open({ deviceId, processing }) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Sur une table de mixage, le traitement du navigateur dégrade souvent la voix.
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
        channelCount: 1,
      },
    });
    const previous = this.stream;
    this.stream = stream;
    this.track = stream.getAudioTracks()[0];

    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.startLevelLoop();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    if (this.worklet) this.source.connect(this.worklet);

    previous?.getTracks().forEach((t) => t.stop());
    return this.track;
  }

  /** Flux PCM16 16 kHz (pour Gemini). */
  async startPcm(callback) {
    this.pcmCallback = callback;
    if (!this.worklet) {
      await this.ctx.audioWorklet.addModule("js/pcm-worklet.js");
      this.worklet = new AudioWorkletNode(this.ctx, "pcm16-downsampler");
      this.worklet.port.onmessage = (e) => this.pcmCallback?.(e.data);
      this.source?.connect(this.worklet);
      // Relié à la sortie via un gain nul pour garantir que le navigateur le fait tourner.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.worklet.connect(mute).connect(this.ctx.destination);
    }
  }

  stopPcm() {
    this.pcmCallback = null;
  }

  startLevelLoop() {
    const data = new Uint8Array(this.analyser.fftSize);
    const loop = () => {
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const s = (data[i] - 128) / 128;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / data.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -60;
      this.onLevel?.(Math.round(((Math.max(-60, Math.min(0, db)) + 60) / 60) * 100));
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.stream = this.track = this.ctx = this.source = this.analyser = this.worklet = null;
    this.pcmCallback = null;
    this.onLevel?.(0);
  }
}

export async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}
