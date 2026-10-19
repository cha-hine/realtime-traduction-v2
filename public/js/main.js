/**
 * Traduction temps réel — orchestration (prompteur.html et index.html).
 */
import { Mic, listMicrophones } from "./audio.js";
import { Transcript, PrompteurView, attachSimpleView, attachHistory } from "./transcript.js";
import { createOpenAIRealtime, createOpenAITranslate } from "./providers/openai.js";
import { createGemini } from "./providers/gemini.js";

const IS_PROMPTEUR = document.body.classList.contains("prompteur");
const SESSION_ROTATION_MS = 55 * 60 * 1000; // sessions OpenAI limitées à 60 min
const ROTATION_GRACE_MS = 5000; // l'ancienne session finit ses phrases avant fermeture
const MAX_RECONNECT_ATTEMPTS = 8;
const STORAGE_KEY = "traduction-settings";

const PROVIDERS = {
  "openai-translate": { label: "OpenAI Translate (le plus rapide)", create: createOpenAITranslate, rotate: true },
  "openai-realtime": { label: "OpenAI Realtime 2.1 (instructions)", create: createOpenAIRealtime, rotate: true },
  gemini: { label: "Gemini Live (instructions)", create: createGemini, rotate: false },
};

const SOURCE_LABELS = {
  gujarati: "Gujarati (Khoja)",
  urdu: "Ourdou",
  hindi: "Hindi",
  arabic: "Arabe",
  auto: "Automatique",
};

const DEFAULT_SETTINGS = {
  provider: "openai-realtime",
  sourceLang: "gujarati",
  instructions: "", // vide = instructions par défaut du serveur
  vad: { mode: "semantic", eagerness: "high", silenceMs: 400, prefixMs: 200, threshold: 0.5 },
  noiseReduction: "",
  browserProcessing: true,
  scrollSpeed: 1.2,
  catchUp: true,
  micId: "",
};

// ==========================================
// État
// ==========================================
const settings = loadSettings();
const transcript = new Transcript();
let serverConfig = { providers: {} };
let defaultInstructions = "";
let mic = null;
let provider = null;
let running = false;
let reconnecting = false;
let rotationTimer = null;
let rotationDueAt = 0;
let sessionInfoTimer = null;
const finalTimes = [];
// ?debug dans l'URL : accès console à la transcription (tests d'affichage sans micro)
if (new URLSearchParams(location.search).has("debug")) window.transcript = transcript;

const $ = (id) => document.getElementById(id);
const el = {
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  statusDot: $("statusIndicator")?.querySelector(".status-dot"),
  statusText: $("statusText"),
  sessionInfo: $("sessionInfo"),
  subtitles: $("subtitles"),
  historyContent: $("historyContent"),
  exportBtn: $("exportBtn"),
  toastContainer: $("toastContainer"),
  settingsHost: $("settingsHost"),
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...saved, vad: { ...DEFAULT_SETTINGS.vad, ...saved.vad } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* stockage indisponible : réglages non mémorisés */
  }
}

/** Réglages envoyés au serveur (validés là-bas). */
function serverSettings() {
  const custom = settings.instructions.trim();
  return {
    sourceLang: settings.sourceLang,
    instructions: custom && custom !== defaultInstructions.trim() ? custom : "",
    vad: settings.vad,
    noiseReduction: settings.noiseReduction || null,
  };
}

// ==========================================
// Initialisation
// ==========================================
document.addEventListener("DOMContentLoaded", async () => {
  renderSettingsPanel();
  initThemeToggle();
  initScrollKeys();

  if (IS_PROMPTEUR) {
    new PrompteurView(transcript, el.subtitles, {
      getSpeed: () => settings.scrollSpeed,
      getCatchUp: () => settings.catchUp,
    });
  } else {
    attachSimpleView(transcript, el.subtitles, {
      emptyText: () => (running ? "En attente de parole..." : 'Cliquez sur "Démarrer" pour commencer'),
    });
  }
  attachHistory(transcript, el.historyContent, formatTime);
  transcript.subscribe((type) => type === "final" && countSegment());

  el.startBtn.addEventListener("click", start);
  el.stopBtn.addEventListener("click", () => stop());
  el.exportBtn?.addEventListener("click", exportHistory);

  updateStatus("disconnected", "Prêt à démarrer");
  await loadServerConfig();
  await loadDefaultInstructions();
  refreshMicList();
  navigator.mediaDevices?.addEventListener("devicechange", refreshMicList);
});

async function loadServerConfig() {
  try {
    serverConfig = await (await fetch("/api/config")).json();
  } catch {
    showToast("Serveur injoignable", "error");
  }
  const select = $("providerSelect");
  for (const option of select.options) {
    const info = serverConfig.providers?.[option.value];
    if (info && !info.available) {
      option.disabled = true;
      option.textContent = `${PROVIDERS[option.value].label} — clé manquante`;
    }
  }
}

async function loadDefaultInstructions() {
  const textarea = $("instructionsInput");
  const wasDefault = !settings.instructions.trim() || settings.instructions.trim() === defaultInstructions.trim();
  try {
    const res = await fetch(`/api/instructions?sourceLang=${encodeURIComponent(settings.sourceLang)}`);
    defaultInstructions = (await res.json()).instructions;
  } catch {
    return;
  }
  if (wasDefault) {
    settings.instructions = "";
    textarea.value = defaultInstructions;
  } else {
    textarea.value = settings.instructions;
  }
  updateInstructionsBadge();
}

function updateInstructionsBadge() {
  const custom = settings.instructions.trim() && settings.instructions.trim() !== defaultInstructions.trim();
  $("instructionsBadge").textContent = custom ? "Personnalisées" : "Par défaut";
}

// ==========================================
// Panneau de réglages
// ==========================================
function renderSettingsPanel() {
  const providerOptions = Object.entries(PROVIDERS)
    .map(([value, p]) => `<option value="${value}">${p.label}</option>`)
    .join("");
  const sourceOptions = Object.entries(SOURCE_LABELS)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  el.settingsHost.innerHTML = `
    <div class="vad-controls">
      <div class="vad-header"><span>Moteur de traduction</span><span class="vad-status" id="applyHint"></span></div>
      <div class="vad-row">
        <span class="vad-label">Fournisseur</span>
        <div class="vad-actions"><select class="vad-select" id="providerSelect">${providerOptions}</select></div>
      </div>
      <div class="vad-row">
        <span class="vad-label">Langue parlée</span>
        <div class="vad-actions"><select class="vad-select" id="sourceSelect">${sourceOptions}</select></div>
      </div>
      <p class="settings-note" id="translateNote">
        Traduit en continu, sans attendre les pauses. Ce modèle détecte la langue tout seul,
        et n'accepte ni instructions ni réglages de découpage.
      </p>
      <button id="applyBtn" class="btn btn-secondary btn-small" hidden>↻ Appliquer maintenant (sans coupure)</button>
    </div>

    <details class="vad-controls instructions-block" data-for="openai-realtime gemini">
      <summary class="vad-header"><span>Instructions de traduction</span><span class="vad-status" id="instructionsBadge">Par défaut</span></summary>
      <textarea id="instructionsInput" class="instructions-input" rows="10" spellcheck="false"
        placeholder="Décrivez ce qu'il faut traduire : contexte, orateur, thème, termes à garder…"></textarea>
      <div class="instructions-actions">
        <button id="instructionsReset" class="btn btn-secondary btn-small">Rétablir le texte par défaut</button>
      </div>
    </details>

    <div class="vad-controls" data-for="openai-realtime gemini">
      <div class="vad-header"><span>Découpage des phrases (VAD)</span><span class="vad-status" id="vadStatus"></span></div>
      <div class="vad-row" data-for="openai-realtime">
        <span class="vad-label">Mode</span>
        <div class="vad-actions">
          <select class="vad-select" id="vadMode">
            <option value="semantic">Sémantique (fin de phrase)</option>
            <option value="server">Silence (plus rapide)</option>
          </select>
        </div>
      </div>
      <div class="vad-row" data-vad="semantic">
        <span class="vad-label">Réactivité</span>
        <div class="vad-actions">
          <select class="vad-select" id="vadEagerness">
            <option value="low">Faible</option>
            <option value="medium">Moyenne</option>
            <option value="high">Élevée</option>
            <option value="auto">Auto</option>
          </select>
        </div>
      </div>
      <div class="vad-row" data-vad="server">
        <span class="vad-label">Silence (ms)</span>
        <div class="vad-actions">
          <input class="vad-slider" id="vadSilence" type="range" min="200" max="1500" step="50" />
          <span class="vad-value" id="vadSilenceValue"></span>
        </div>
      </div>
      <div class="vad-row" data-vad="server">
        <span class="vad-label">Préfixe (ms)</span>
        <div class="vad-actions">
          <input class="vad-slider" id="vadPrefix" type="range" min="0" max="1000" step="50" />
          <span class="vad-value" id="vadPrefixValue"></span>
        </div>
      </div>
    </div>

    <div class="mic-controls">
      <label class="mic-label" for="micSelect">Microphone</label>
      <div class="mic-actions">
        <select id="micSelect" class="mic-select"></select>
        <button id="micRefresh" class="btn btn-secondary btn-small">Rafraîchir</button>
      </div>
    </div>

    <div class="vad-controls">
      <div class="vad-header"><span>Traitement audio</span></div>
      <label class="check-row"><input type="checkbox" id="browserProcessing" />
        Filtrage du navigateur (à décocher si le son vient de la table de mixage)</label>
      <div class="vad-row" data-for="openai-realtime openai-translate">
        <span class="vad-label">Réduction bruit OpenAI</span>
        <div class="vad-actions">
          <select class="vad-select" id="noiseReduction">
            <option value="">Aucune</option>
            <option value="near_field">Micro proche</option>
            <option value="far_field">Micro éloigné</option>
          </select>
        </div>
      </div>
    </div>

    <div class="vad-controls" ${IS_PROMPTEUR ? "" : "hidden"}>
      <div class="vad-header"><span>Vitesse défilement</span><span class="vad-status" id="scrollSpeedValue"></span></div>
      <div class="vad-row">
        <span class="vad-label">Ligne suivante</span>
        <div class="vad-actions"><input id="scrollSpeed" class="vad-slider" type="range" min="0" max="6" step="0.1" /></div>
      </div>
      <label class="check-row"><input type="checkbox" id="catchUp" />
        Rattrapage auto (accélère si la dernière phrase est hors écran)</label>
    </div>

    <div class="stats-panel">
      <div><span class="stats-value" id="statSegments">0</span><span class="stats-label">phrases</span></div>
      <div><span class="stats-value" id="statPerMin">0</span><span class="stats-label">/ minute</span></div>
      <div><span class="stats-value" id="statLatency">–</span><span class="stats-label">latence</span></div>
      <div><span class="speech-dot" id="speechDot"></span><span class="stats-label">parole</span></div>
      <div class="audio-level-bar stats-level"><div class="audio-level-fill" id="audioLevel"></div></div>
    </div>
  `;

  // Valeurs initiales
  $("providerSelect").value = settings.provider;
  $("sourceSelect").value = settings.sourceLang;
  $("vadMode").value = settings.vad.mode;
  $("vadEagerness").value = settings.vad.eagerness;
  $("vadSilence").value = settings.vad.silenceMs;
  $("vadPrefix").value = settings.vad.prefixMs;
  $("noiseReduction").value = settings.noiseReduction;
  $("browserProcessing").checked = settings.browserProcessing;
  $("scrollSpeed").value = settings.scrollSpeed;
  $("catchUp").checked = settings.catchUp;
  refreshSettingsVisibility();
  updateScrollSpeedDisplay();

  // Changements nécessitant une nouvelle session
  const onSessionSetting = (fn) => (e) => {
    fn(e);
    saveSettings();
    refreshSettingsVisibility();
    markNeedsApply();
  };

  $("providerSelect").addEventListener("change", onSessionSetting((e) => (settings.provider = e.target.value)));
  $("sourceSelect").addEventListener(
    "change",
    onSessionSetting((e) => {
      settings.sourceLang = e.target.value;
      loadDefaultInstructions();
    }),
  );
  $("noiseReduction").addEventListener("change", onSessionSetting((e) => (settings.noiseReduction = e.target.value)));

  let instructionsTimer = null;
  $("instructionsInput").addEventListener("input", (e) => {
    settings.instructions = e.target.value;
    updateInstructionsBadge();
    clearTimeout(instructionsTimer);
    instructionsTimer = setTimeout(() => {
      saveSettings();
      markNeedsApply();
    }, 400);
  });
  $("instructionsReset").addEventListener("click", () => {
    settings.instructions = "";
    $("instructionsInput").value = defaultInstructions;
    updateInstructionsBadge();
    saveSettings();
    markNeedsApply();
  });

  // VAD : appliqué en direct pour OpenAI Realtime, au prochain démarrage pour Gemini
  const onVad = (fn) => (e) => {
    fn(e);
    saveSettings();
    refreshSettingsVisibility();
    if (running && provider?.updateVad) provider.updateVad(settings.vad);
    else markNeedsApply();
  };
  $("vadMode").addEventListener("change", onVad((e) => (settings.vad.mode = e.target.value)));
  $("vadEagerness").addEventListener("change", onVad((e) => (settings.vad.eagerness = e.target.value)));
  $("vadSilence").addEventListener("change", onVad((e) => (settings.vad.silenceMs = Number(e.target.value))));
  $("vadPrefix").addEventListener("change", onVad((e) => (settings.vad.prefixMs = Number(e.target.value))));
  $("vadSilence").addEventListener("input", (e) => ($("vadSilenceValue").textContent = e.target.value));
  $("vadPrefix").addEventListener("input", (e) => ($("vadPrefixValue").textContent = e.target.value));

  $("applyBtn").addEventListener("click", () => rotate("réglages appliqués"));

  // Micro
  $("micSelect").addEventListener("change", async (e) => {
    settings.micId = e.target.value;
    saveSettings();
    await reopenMic();
  });
  $("micRefresh").addEventListener("click", () => refreshMicList(true));
  $("browserProcessing").addEventListener("change", async (e) => {
    settings.browserProcessing = e.target.checked;
    saveSettings();
    await reopenMic();
  });

  // Défilement
  $("scrollSpeed").addEventListener("input", (e) => {
    settings.scrollSpeed = parseFloat(e.target.value) || 0;
    updateScrollSpeedDisplay();
    saveSettings();
  });
  $("catchUp").addEventListener("change", (e) => {
    settings.catchUp = e.target.checked;
    saveSettings();
  });
}

function refreshSettingsVisibility() {
  document.querySelectorAll("[data-for]").forEach((node) => {
    node.hidden = !node.dataset.for.split(" ").includes(settings.provider);
  });
  const vadMode = settings.provider === "gemini" ? "gemini" : settings.vad.mode;
  document.querySelectorAll("[data-vad]").forEach((node) => {
    // Gemini : réactivité (sensibilité de fin) + silence + préfixe
    node.hidden = vadMode !== "gemini" && node.dataset.vad !== vadMode;
  });
  $("translateNote").hidden = settings.provider !== "openai-translate";
  $("sourceSelect").closest(".vad-row").hidden = settings.provider === "openai-translate";
  $("vadStatus").textContent = settings.provider === "gemini" ? "au démarrage" : "en direct";
  $("vadSilenceValue").textContent = settings.vad.silenceMs;
  $("vadPrefixValue").textContent = settings.vad.prefixMs;
}

function markNeedsApply() {
  if (!running) return;
  $("applyBtn").hidden = false;
  $("applyHint").textContent = "modifié";
}

function clearNeedsApply() {
  $("applyBtn").hidden = true;
  $("applyHint").textContent = "";
}

function updateScrollSpeedDisplay() {
  const value = settings.scrollSpeed.toFixed(1);
  $("scrollSpeed").value = settings.scrollSpeed;
  $("scrollSpeedValue").textContent = `${value} px/frame`;
  const mini = $("miniScrollValue");
  if (mini) mini.textContent = value;
}

// Vitesse via flèches gauche/droite et pointeur de diapo USB (PageUp/PageDown)
function initScrollKeys() {
  if (!IS_PROMPTEUR) return;
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    let delta = 0;
    if (e.key === "ArrowRight" || e.key === "PageDown") delta = 0.1;
    if (e.key === "ArrowLeft" || e.key === "PageUp") delta = -0.1;
    if (!delta) return;
    e.preventDefault();
    settings.scrollSpeed = Math.min(6, Math.max(0, Math.round((settings.scrollSpeed + delta) * 10) / 10));
    updateScrollSpeedDisplay();
    saveSettings();
  });
}

function initThemeToggle() {
  const btn = $("themeToggleBtn");
  if (!btn) return;
  const apply = (dark) => {
    document.body.classList.toggle("dark", dark);
    $("themeToggleIcon").textContent = dark ? "☀️" : "🌙";
    $("themeToggleLabel").textContent = dark ? "Mode beige" : "Mode noir";
  };
  apply(localStorage.getItem("prompteur-dark") !== "0");
  btn.addEventListener("click", () => {
    const dark = !document.body.classList.contains("dark");
    apply(dark);
    localStorage.setItem("prompteur-dark", dark ? "1" : "0");
  });
}

// ==========================================
// Micro
// ==========================================
async function refreshMicList(requestPermission = false) {
  const select = $("micSelect");
  if (!navigator.mediaDevices?.enumerateDevices) {
    select.disabled = true;
    return;
  }
  if (requestPermission && !mic) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch {
      showToast("Autorisation micro refusée", "error");
      return;
    }
  }
  const mics = await listMicrophones();
  select.replaceChildren(
    ...mics.map((m, i) => new Option(m.label || `Microphone ${i + 1}`, m.deviceId)),
  );
  select.disabled = mics.length === 0;
  if (!mics.length) select.append(new Option("Aucun micro", ""));
  if (mics.some((m) => m.deviceId === settings.micId)) select.value = settings.micId;
}

async function reopenMic() {
  if (!mic) return;
  try {
    const track = await mic.open({ deviceId: settings.micId, processing: settings.browserProcessing });
    await provider?.replaceTrack(track);
    showToast("Micro changé", "success");
  } catch (error) {
    showToast(`Micro : ${error.message}`, "error");
  }
}

// Écrit dans la page seulement si le niveau a vraiment changé :
// évite de recalculer la mise en page à chaque image pendant le défilement.
let lastLevel = -1;
let lastDotColor = "";
function onLevel(level) {
  const rounded = Math.round(level / 4) * 4;
  if (rounded !== lastLevel) {
    lastLevel = rounded;
    const bar = $("audioLevel");
    if (bar) bar.style.width = `${rounded}%`;
  }
  const color = level < 5 ? "#4b5563" : level < 40 ? "#22c55e" : level < 75 ? "#eab308" : "#ef4444";
  if (color !== lastDotColor) {
    lastDotColor = color;
    const dot = $("miniAudioDot");
    if (dot) dot.style.background = color;
  }
}

// ==========================================
// Cycle de vie de la traduction
// ==========================================
function makeProvider() {
  const ctx = {
    mic,
    transcript,
    settings: serverSettings(),
    onSpeech: (speaking) => $("speechDot")?.classList.toggle("active", speaking),
    onLatency: (ms) => ($("statLatency").textContent = `${Math.round(ms)} ms`),
    onStatus: (text) => updateStatus("connected", text),
    onError: (message, { rateLimit, fatal } = {}) => {
      if (instance !== provider) return;
      if (rateLimit) {
        stop();
        showRateLimitAlert();
      } else if (fatal) {
        stop();
        updateStatus("error", "Erreur");
        showToast(message, "error", 8000);
      } else {
        showToast(`Erreur : ${message}`, "error");
      }
    },
    onClosed: (reason) => {
      if (instance === provider && running) reconnect(reason);
    },
  };
  const instance = PROVIDERS[settings.provider].create(ctx);
  return instance;
}

async function connectProvider() {
  const instance = makeProvider();
  try {
    await instance.connect();
    return instance;
  } catch (error) {
    instance.close();
    throw error;
  }
}

async function start() {
  if (running) return;
  running = true;
  el.startBtn.disabled = true;
  updateStatus("connecting", "Connexion en cours...");

  try {
    mic = new Mic({ onLevel });
    await mic.open({ deviceId: settings.micId, processing: settings.browserProcessing });
    refreshMicList();
    provider = await connectProvider();
    scheduleRotation();
    clearNeedsApply();
    el.stopBtn.disabled = false;
    updateStatus("connected", `Traduction active — ${PROVIDERS[settings.provider].label}`);
    showToast("Traduction démarrée !", "success");
  } catch (error) {
    console.error("Erreur démarrage:", error);
    showToast(`Erreur : ${error.message}`, "error", 8000);
    stop({ exportFile: false });
    updateStatus("error", "Erreur de connexion");
  }
}

function stop({ exportFile = true } = {}) {
  const wasRunning = running;
  running = false;
  reconnecting = false;
  clearTimeout(rotationTimer);
  clearInterval(sessionInfoTimer);
  provider?.close();
  provider = null;
  mic?.close();
  mic = null;
  el.startBtn.disabled = false;
  el.stopBtn.disabled = true;
  el.sessionInfo.textContent = "";
  $("speechDot")?.classList.remove("active");
  clearNeedsApply();
  if (wasRunning) {
    updateStatus("disconnected", "Arrêté");
    // Sauvegarde automatique de la séance
    if (exportFile && transcript.finals().length) exportHistory();
  }
}

/** Reconnexion après coupure, avec délai croissant (1 s, 2 s, 4 s… max 15 s). */
async function reconnect(reason) {
  if (reconnecting || !running) return;
  reconnecting = true;
  console.warn("⚠️ Reconnexion :", reason);
  clearTimeout(rotationTimer);
  provider?.close();
  provider = null;

  for (let attempt = 0; running; attempt++) {
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      showToast("Reconnexion impossible, traduction arrêtée", "error", 8000);
      stop();
      updateStatus("error", "Connexion perdue");
      return;
    }
    updateStatus("connecting", `Reconnexion (${attempt + 1})...`);
    await sleep(Math.min(15000, 1000 * 2 ** attempt));
    if (!running) return;
    try {
      const next = await connectProvider();
      if (!running) return next.close();
      provider = next;
      reconnecting = false;
      scheduleRotation();
      updateStatus("connected", "Reconnecté");
      showToast("Reconnexion réussie", "success");
      return;
    } catch (error) {
      console.error("Échec reconnexion:", error);
    }
  }
}

/**
 * Rotation sans coupure : la nouvelle session est ouverte AVANT de fermer l'ancienne,
 * qui termine ses phrases en cours. Sert aussi à appliquer de nouveaux réglages.
 */
async function rotate(reason = "rotation") {
  if (!running || reconnecting) return;
  clearTimeout(rotationTimer);
  const old = provider;
  try {
    const next = await connectProvider();
    if (!running || provider !== old) return next.close();
    old?.detachAudio();
    provider = next;
    setTimeout(() => old?.close(), ROTATION_GRACE_MS);
    clearNeedsApply();
    scheduleRotation();
    console.log("🔄 Session renouvelée :", reason);
    if (reason !== "rotation") showToast("Réglages appliqués", "success");
  } catch (error) {
    console.error("Échec rotation:", error);
    showToast(`Renouvellement impossible : ${error.message}`, "warning");
    rotationTimer = setTimeout(() => rotate(), 30000);
  }
}

function scheduleRotation() {
  clearTimeout(rotationTimer);
  clearInterval(sessionInfoTimer);
  if (!PROVIDERS[settings.provider].rotate) {
    el.sessionInfo.textContent = "";
    return;
  }
  rotationDueAt = Date.now() + SESSION_ROTATION_MS;
  rotationTimer = setTimeout(() => rotate(), SESSION_ROTATION_MS);
  const update = () => {
    const minutes = Math.max(0, Math.ceil((rotationDueAt - Date.now()) / 60000));
    el.sessionInfo.textContent = `Renouvellement dans ~${minutes} min`;
  };
  update();
  sessionInfoTimer = setInterval(update, 30000);
}

// ==========================================
// Statistiques / export
// ==========================================
function countSegment() {
  const now = Date.now();
  finalTimes.push(now);
  while (finalTimes.length && now - finalTimes[0] > 60000) finalTimes.shift();
  $("statSegments").textContent = transcript.finals().length;
  $("statPerMin").textContent = finalTimes.length;
}

function exportHistory() {
  const finals = transcript.finals();
  if (!finals.length) {
    showToast("Aucun historique à exporter", "warning");
    return;
  }
  const content = finals.map((s) => `[${formatTime(s.timestamp)}] ${s.text}`).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: `traduction-${formatDate(Date.now())}.txt`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Historique exporté !", "success");
}

// ==========================================
// Interface
// ==========================================
function updateStatus(state, text) {
  if (el.statusText) el.statusText.textContent = text;
  el.statusDot?.classList.remove("connected", "connecting", "error");
  if (state !== "disconnected") el.statusDot?.classList.add(state);
}

function showToast(message, type = "info", duration = 3000) {
  const toast = Object.assign(document.createElement("div"), {
    className: `toast ${type}`,
    textContent: message,
  });
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100px)";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function showRateLimitAlert() {
  const overlay = document.createElement("div");
  overlay.className = "rate-limit-overlay";
  overlay.innerHTML = `
    <div class="rate-limit-box">
      <div class="rate-limit-icon">⚠️</div>
      <h2>Limite de requêtes atteinte</h2>
      <p>Le fournisseur refuse temporairement les requêtes (quota ou crédits).
         Patientez quelques minutes, vérifiez vos crédits, ou changez de fournisseur.</p>
      <button class="btn btn-danger">Compris</button>
    </div>`;
  const close = () => overlay.remove();
  overlay.querySelector("button").addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close(), { once: true });
  document.body.appendChild(overlay);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
