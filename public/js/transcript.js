/**
 * Transcription : liste ordonnée de segments traduits.
 * Un segment est créé "live" puis rempli au fil de l'eau (streaming) et finalisé.
 * Les vues (prompteur, page simple, historique) s'abonnent aux changements.
 */
const DUPLICATE_WINDOW_MS = 10000;

const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[.,!?;:'"«»()[\]{}\-–—…]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export class Transcript {
  constructor() {
    this.segments = [];
    this.listeners = new Set();
    this.seq = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
  }

  emit(type, seg) {
    this.listeners.forEach((fn) => fn(type, seg));
  }

  begin() {
    const seg = { id: ++this.seq, text: "", live: true, timestamp: Date.now() };
    this.segments.push(seg);
    this.emit("add", seg);
    return seg.id;
  }

  get(id) {
    return this.segments.find((s) => s.id === id);
  }

  append(id, delta) {
    const seg = this.get(id);
    if (!seg || !seg.live || !delta) return;
    seg.text += delta;
    this.emit("update", seg);
  }

  set(id, text) {
    const seg = this.get(id);
    if (!seg || !seg.live || seg.text === text) return;
    seg.text = text;
    this.emit("update", seg);
  }

  finalize(id) {
    const seg = this.get(id);
    if (!seg || !seg.live) return;
    const text = seg.text
      .replace(/\s+/g, " ")
      .replace(/\.{2,}\s*$|…\s*$/, "") // "..." de phrase coupée
      .trim();

    const previous = this.lastFinal();
    const isNoise = !/\p{L}/u.test(text); // vide ou ponctuation seule
    const isRepeat =
      previous &&
      Date.now() - previous.timestamp < DUPLICATE_WINDOW_MS &&
      normalize(previous.text) === normalize(text);

    if (isNoise || isRepeat) return this.remove(id);

    seg.text = text;
    seg.live = false;
    this.emit("update", seg);
    this.emit("final", seg);
  }

  remove(id) {
    const index = this.segments.findIndex((s) => s.id === id);
    if (index === -1) return;
    const [seg] = this.segments.splice(index, 1);
    this.emit("remove", seg);
  }

  lastFinal() {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (!this.segments[i].live) return this.segments[i];
    }
    return null;
  }

  recentFinals(count) {
    return this.segments.filter((s) => !s.live).slice(-count).map((s) => s.text);
  }

  finals() {
    return this.segments.filter((s) => !s.live);
  }
}

/**
 * Découpe un flux de texte continu (gpt-realtime-translate, Gemini) en phrases
 * pour l'affichage : chaque phrase terminée devient un segment final.
 */
export class SentenceStreamer {
  constructor(transcript, { idleMs = 1500, maxChars = 260 } = {}) {
    this.transcript = transcript;
    this.idleMs = idleMs;
    this.maxChars = maxChars;
    this.current = null;
    this.buffer = "";
    this.timer = null;
  }

  push(delta) {
    if (!delta) return;
    if (!this.current) {
      this.current = this.transcript.begin();
      delta = delta.trimStart();
    }
    this.buffer += delta;

    // Coupe après une ponctuation de fin de phrase suivie d'un espace.
    let match;
    const boundary = /[.!?…»](?=\s+\S)/g;
    let cut = -1;
    while ((match = boundary.exec(this.buffer))) cut = match.index + 1;
    if (cut === -1 && this.buffer.length > this.maxChars) {
      cut = this.buffer.lastIndexOf(" ", this.maxChars);
    }

    if (cut > 0) {
      this.transcript.set(this.current, this.buffer.slice(0, cut));
      this.transcript.finalize(this.current);
      this.buffer = this.buffer.slice(cut).trimStart();
      this.current = this.transcript.begin();
    }
    this.transcript.set(this.current, this.buffer);

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.idleMs);
  }

  flush() {
    clearTimeout(this.timer);
    if (this.current) this.transcript.finalize(this.current);
    this.current = null;
    this.buffer = "";
  }
}

// ==========================================
// Vues
// ==========================================

/** Page simple : les 2 dernières phrases. */
export function attachSimpleView(transcript, container, { maxItems = 2, emptyText }) {
  const render = () => {
    const items = transcript.segments.filter((s) => s.text).slice(-maxItems);
    container.replaceChildren(
      ...(items.length
        ? items.map((s) => {
            const div = document.createElement("div");
            div.className = `subtitle final${s.live ? " live" : ""}`;
            div.textContent = s.text;
            return div;
          })
        : [Object.assign(document.createElement("div"), { className: "empty-state", textContent: emptyText() })]),
    );
  };
  transcript.subscribe(render);
  render();
  return { render };
}

/**
 * Prompteur : défilement continu de bas en haut.
 * - vitesse indépendante de la fréquence de l'écran (px/frame calibré à 60 i/s)
 * - pause quand l'avant-dernière phrase atteint le haut (on garde 2 phrases lisibles)
 * - rattrapage auto : accélère si la dernière phrase est encore sous l'écran
 * - les phrases sorties par le haut sont supprimées (DOM léger sur 2 h de sermon)
 * - une reconnexion n'efface plus l'écran
 */
export class PrompteurView {
  constructor(transcript, container, { getSpeed, getCatchUp }) {
    this.container = container;
    this.getSpeed = getSpeed;
    this.getCatchUp = getCatchUp;
    this.elements = new Map();
    this.list = document.createElement("div");
    this.list.className = "prompteur-list";
    container.replaceChildren(this.list);
    this.y = container.clientHeight;
    this.velocity = 0;
    this.last = performance.now();
    transcript.subscribe((type, seg) => this.onChange(type, seg));
    requestAnimationFrame((t) => this.tick(t));
  }

  onChange(type, seg) {
    let el = this.elements.get(seg.id);
    if (type === "remove") {
      el?.remove();
      this.elements.delete(seg.id);
      return;
    }
    if (!seg.text) return;
    if (!el) {
      if (!this.list.children.length) this.y = this.container.clientHeight;
      el = document.createElement("div");
      this.elements.set(seg.id, el);
      this.list.appendChild(el);
    }
    el.className = `subtitle final${seg.live ? " live" : ""}`;
    el.textContent = seg.text;
  }

  tick(now) {
    const dt = Math.min(100, now - this.last) / (1000 / 60); // en "frames à 60 i/s"
    this.last = now;
    const children = this.list.children;
    const height = this.container.clientHeight;

    if (children.length) {
      // Retire les phrases entièrement sorties par le haut (en gardant les 2 dernières).
      // Le décalage est mesuré avant/après retrait : aucun saut visible.
      while (children.length > 2) {
        const first = children[0];
        if (this.y + first.offsetTop + first.offsetHeight >= 0) break;
        const before = children[1].offsetTop;
        this.elements.forEach((el, id) => el === first && this.elements.delete(id));
        first.remove();
        this.y += before - children[0].offsetTop;
      }

      const speed = this.getSpeed();
      const last = children[children.length - 1];
      const anchor = children.length >= 2 ? children[children.length - 2] : last;
      const distanceToStop = this.y + anchor.offsetTop; // > 0 tant que l'avant-dernière n'est pas en haut
      const overflow = this.y + last.offsetTop + last.offsetHeight - height;
      const catchingUp = this.getCatchUp() && overflow > 0 && this.y + last.offsetTop > 0;

      let target;
      if (catchingUp) {
        target = Math.max(speed, Math.min(14, speed + overflow * 0.02));
      } else if (distanceToStop <= 0) {
        target = 0;
      } else {
        // Ralentit en douceur sur les derniers pixels avant l'arrêt
        target = Math.min(speed, Math.max(0.15, distanceToStop * 0.12));
      }

      // Accélérations / ralentissements progressifs (~120 ms) au lieu d'à-coups
      this.velocity += (target - this.velocity) * (1 - Math.exp(-0.14 * dt));
      let step = this.velocity * dt;
      if (!catchingUp && distanceToStop > 0) step = Math.min(step, distanceToStop); // pile à l'arrêt
      if (!catchingUp && distanceToStop <= 0) step = 0;

      this.y -= step;
      this.list.style.transform = `translate3d(0, ${this.y.toFixed(2)}px, 0)`;
    }

    requestAnimationFrame((t) => this.tick(t));
  }
}

/** Historique complet (ajout incrémental, plus de reconstruction totale). */
export function attachHistory(transcript, container, formatTime) {
  if (!container) return;
  transcript.subscribe((type, seg) => {
    if (type !== "final") return;
    const item = document.createElement("div");
    item.className = "history-item";
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatTime(seg.timestamp);
    const text = document.createElement("span");
    text.className = "history-text";
    text.textContent = seg.text;
    item.append(time, text);
    container.appendChild(item);
    container.scrollTop = container.scrollHeight;
  });
}
