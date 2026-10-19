// AudioWorklet : convertit le micro (48 kHz float) en PCM16 mono 16 kHz,
// envoyé par paquets de 50 ms (format attendu par Gemini Live).
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.chunk = new Int16Array(800); // 50 ms à 16 kHz
    this.length = 0;
    this.acc = 0;
    this.accCount = 0;
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    // Moyenne des échantillons de chaque fenêtre (anti-repliement simple)
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.accCount++;
      this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.accCount));
        this.chunk[this.length++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.acc = 0;
        this.accCount = 0;
        if (this.length === this.chunk.length) {
          this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
          this.chunk = new Int16Array(800);
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
