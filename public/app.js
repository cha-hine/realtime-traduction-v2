/**
 * Traduction Temps Réel - Client WebRTC
 * Urdu/Hindi → Français via OpenAI Realtime API
 */

// ==========================================
// Configuration
// ==========================================
const CONFIG = {
  SESSION_ROTATION_MS: 55 * 60 * 1000, // 55 minutes (avant expiration 60 min)
  RECONNECT_DELAY_MS: 2000,
  MAX_DISPLAYED_SUBTITLES: 2,
  MAX_HISTORY_ITEMS: 100,
  MAX_PROMPTEUR_ITEMS: 60,
  PROMPTEUR_SCROLL_PX_PER_FRAME: 1.2,
};

const VAD_SETTINGS = {
  eagerness: "high",
  prefixMs: 200,
};

const VAD_LIMITS = {
  prefixMs: { min: 0, max: 1000, step: 50 },
};

// ==========================================
// State
// ==========================================
let peerConnection = null;
let dataChannel = null;
let mediaStream = null;
let audioSender = null;
let audioContext = null;
let analyser = null;
let reconnectTimer = null;
let sessionRotationTimer = null;
let isRunning = false;
let sessionReady = false;
let vadUpdateSupported = false;
let vadSupportChecked = false;
let selectedMicId = null;

// Subtitles state
let currentLine = "";
let subtitles = [];

// Compteur de requêtes
let requestCount = 0;
let requestsPerMinute = 0;
let requestCounterInterval = null;

// VAD state (server-side detection)
let isSpeaking = false;
const IS_PROMPTEUR = document.body.classList.contains("prompteur");
let prompteurScrollSpeed = CONFIG.PROMPTEUR_SCROLL_PX_PER_FRAME;
let prompteurScrollRaf = null;
let prompteurScrollY = 0;
let prompteurListEl = null;
const prompteurSeenKeys = new Set();

// DOM Elements
const elements = {
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  statusIndicator: document.getElementById("statusIndicator"),
  statusText: document.getElementById("statusText"),
  statusDot: null,
  sessionInfo: document.getElementById("sessionInfo"),
  subtitlesContainer: document.getElementById("subtitles"),
  audioLevelContainer: document.getElementById("audioLevelContainer"),
  audioLevel: document.getElementById("audioLevel"),
  historyContent: document.getElementById("historyContent"),
  exportBtn: document.getElementById("exportBtn"),
  toastContainer: document.getElementById("toastContainer"),
  requestCounter: null,
  micSelect: document.getElementById("micSelect"),
  micRefresh: document.getElementById("micRefresh"),
  scrollSpeed: document.getElementById("scrollSpeed"),
  scrollSpeedValue: document.getElementById("scrollSpeedValue"),
  vadEagerness: document.getElementById("vadEagerness"),
  vadPrefixValue: document.getElementById("vadPrefixValue"),
  vadStatus: document.getElementById("vadStatus"),
  vadPrefixSlider: document.querySelector('[data-vad="prefix"]'),
};

// ==========================================
// Initialization
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  elements.statusDot = elements.statusIndicator.querySelector(".status-dot");

  // Créer le compteur de requêtes
  createRequestCounter();

  // Créer le panneau VAD (indicateur simple)
  createVadIndicator();

  initVadControls();
  initMicControls();
  initPrompteurControls();
  initThemeToggle();

  // Event listeners
  elements.startBtn.addEventListener("click", startRealtime);
  elements.stopBtn.addEventListener("click", stopRealtime);
  elements.exportBtn.addEventListener("click", exportHistory);

  // Initial state
  renderSubtitles();
  updateStatus("disconnected", "Prêt à démarrer");
  if (IS_PROMPTEUR) {
    window.addEventListener("resize", () => renderSubtitles());
  }
});

function initThemeToggle() {
  const btn = document.getElementById("themeToggleBtn");
  const icon = document.getElementById("themeToggleIcon");
  const label = document.getElementById("themeToggleLabel");
  if (!btn) return;

  const applyTheme = (dark) => {
    document.body.classList.toggle("dark", dark);
    if (dark) {
      icon.textContent = "☀️";
      label.textContent = "Mode beige";
    } else {
      icon.textContent = "🌙";
      label.textContent = "Mode noir";
    }
  };

  // Restaurer la préférence sauvegardée
  applyTheme(localStorage.getItem("prompteur-dark") === "1");

  btn.addEventListener("click", () => {
    const isDark = !document.body.classList.contains("dark");
    applyTheme(isDark);
    localStorage.setItem("prompteur-dark", isDark ? "1" : "0");
  });
}

function initPrompteurControls() {
  if (!elements.scrollSpeed || !elements.scrollSpeedValue) return;

  const updateValue = (value) => {
    elements.scrollSpeedValue.textContent = `${value} px/frame`;
  };

  elements.scrollSpeed.value = String(prompteurScrollSpeed);
  updateValue(prompteurScrollSpeed);

  elements.scrollSpeed.addEventListener("input", () => {
    const next = parseFloat(elements.scrollSpeed.value);
    if (!Number.isNaN(next)) {
      prompteurScrollSpeed = next;
      updateValue(next);
    }
  });

  // Contrôle vitesse via touches gauche/droite et pointeur de diapo USB (PageUp/PageDown)
  const speedStep = 0.1;
  const speedMin = 0;
  const speedMax = 6;

  document.addEventListener("keydown", (e) => {
    // Ignorer si focus sur un input/select/textarea
    if (
      ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)
    )
      return;

    let changed = false;
    if (e.key === "ArrowRight" || e.key === "PageDown") {
      prompteurScrollSpeed = Math.min(
        speedMax,
        Math.round((prompteurScrollSpeed + speedStep) * 10) / 10,
      );
      changed = true;
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      prompteurScrollSpeed = Math.max(
        speedMin,
        Math.round((prompteurScrollSpeed - speedStep) * 10) / 10,
      );
      changed = true;
    }

    if (changed) {
      e.preventDefault();
      elements.scrollSpeed.value = String(prompteurScrollSpeed);
      updateValue(prompteurScrollSpeed);
    }
  });
}

/**
 * Crée l'élément d'affichage du compteur de requêtes
 */
function createRequestCounter() {
  const counter = document.createElement("div");
  counter.id = "requestCounter";
  counter.style.cssText = `
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border: 1px solid #3498db;
    border-radius: 12px;
    padding: 15px 20px;
    font-family: monospace;
    min-width: 200px;
    box-shadow: 0 4px 15px rgba(52, 152, 219, 0.2);
  `;
  counter.innerHTML = `
    <div style="color: #3498db; font-size: 12px; margin-bottom: 8px; text-transform: uppercase;">Requêtes API</div>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="color: #fff; font-size: 24px; font-weight: bold;" id="reqPerMin">0</div>
        <div style="color: #888; font-size: 11px;">par minute</div>
      </div>
      <div style="border-left: 1px solid #333; padding-left: 15px; margin-left: 15px;">
        <div style="color: #f39c12; font-size: 18px; font-weight: bold;" id="reqTotal">0</div>
        <div style="color: #888; font-size: 11px;">total session</div>
      </div>
    </div>
  `;
  const statsHost = document.getElementById("prompteurStats");
  if (statsHost) {
    statsHost.appendChild(counter);
  } else {
    document.body.appendChild(counter);
  }
  elements.requestCounter = counter;
}

/**
 * Crée l'indicateur VAD simplifié (détection serveur)
 */
function createVadIndicator() {
  const panel = document.createElement("div");
  panel.id = "vadPanel";
  panel.style.cssText = `
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border: 1px solid #9b59b6;
    border-radius: 12px;
    padding: 15px 20px;
    min-width: 200px;
    box-shadow: 0 4px 15px rgba(155, 89, 182, 0.2);
  `;

  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <div style="color: #9b59b6; font-size: 12px; text-transform: uppercase;">Détection Vocale</div>
      <div id="vadIndicator" style="
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #555;
        transition: all 0.15s;
        box-shadow: 0 0 0 0 rgba(46, 204, 113, 0);
      "></div>
    </div>
    <div style="color: #888; font-size: 11px; text-align: center;">
      Mode: Semantic VAD (OpenAI)
    </div>
    <!-- Indicateur de niveau audio -->
    <div style="margin-top: 15px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
        <span style="color: #888; font-size: 11px;">Niveau audio</span>
        <span id="audioLevelValue" style="color: #fff; font-size: 11px;">0</span>
      </div>
      <div style="background: #2d2d44; border-radius: 4px; height: 8px; overflow: hidden;">
        <div id="vadLevelBar" style="
          height: 100%;
          width: 0%;
          background: linear-gradient(90deg, #2ecc71, #f1c40f, #e74c3c);
          transition: width 0.05s;
        "></div>
      </div>
    </div>
    <!-- Stats -->
    <div style="border-top: 1px solid #333; padding-top: 10px; margin-top: 10px;">
      <div style="display: flex; justify-content: space-between;">
        <span style="color: #888; font-size: 10px;">Détections</span>
        <span id="vadDetections" style="color: #2ecc71; font-size: 10px;">0</span>
      </div>
    </div>
  `;

  const statsHost = document.getElementById("prompteurStats");
  if (statsHost) {
    statsHost.appendChild(panel);
  } else {
    document.body.appendChild(panel);
  }
}

/**
 * Démarre le compteur de requêtes par minute
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function updateVadDisplay() {
  if (elements.vadEagerness) {
    elements.vadEagerness.value = VAD_SETTINGS.eagerness;
  }
  if (elements.vadPrefixSlider) {
    elements.vadPrefixSlider.value = String(VAD_SETTINGS.prefixMs);
  }
  if (elements.vadPrefixValue) {
    elements.vadPrefixValue.textContent = String(VAD_SETTINGS.prefixMs);
  }
}

function setVadUpdateSupported(supported) {
  vadUpdateSupported = supported;
  vadSupportChecked = true;

  if (elements.vadStatus) {
    elements.vadStatus.textContent = supported ? "Live" : "Unsupported";
  }

  document.querySelectorAll("[data-vad]").forEach((slider) => {
    slider.disabled = !supported;
  });
}

function maybeEnableVadUpdates(session) {
  if (vadSupportChecked) return;
  if (
    session &&
    Object.prototype.hasOwnProperty.call(session, "turn_detection")
  ) {
    setVadUpdateSupported(true);
  }
}

function sendVadUpdate() {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  if (!sessionReady || !vadUpdateSupported) return;

  const event = {
    type: "session.update",
    session: {
      type: "realtime",
      turn_detection: {
        type: "semantic_vad",
        eagerness: VAD_SETTINGS.eagerness,
        prefix_padding_ms: VAD_SETTINGS.prefixMs,
      },
    },
  };

  dataChannel.send(JSON.stringify(event));
}

function initVadControls() {
  updateVadDisplay();

  if (elements.vadEagerness) {
    elements.vadEagerness.addEventListener("change", () => {
      VAD_SETTINGS.eagerness = elements.vadEagerness.value;
      sendVadUpdate();
    });
  }

  if (elements.vadPrefixSlider) {
    elements.vadPrefixSlider.addEventListener("input", () => {
      VAD_SETTINGS.prefixMs = Math.round(
        clamp(
          parseFloat(elements.vadPrefixSlider.value),
          VAD_LIMITS.prefixMs.min,
          VAD_LIMITS.prefixMs.max,
        ),
      );
      updateVadDisplay();
      sendVadUpdate();
    });
  }
}

async function refreshMicrophones(requestPermission) {
  let tempStream = null;

  if (requestPermission) {
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      showToast("Autorisation micro refus?e", "error");
      return;
    }
  }

  await listMicrophones();

  if (tempStream) {
    tempStream.getTracks().forEach((track) => track.stop());
  }
}

async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((device) => device.kind === "audioinput");

  if (!elements.micSelect) return;

  elements.micSelect.innerHTML = "";

  if (mics.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Aucun micro";
    elements.micSelect.appendChild(option);
    elements.micSelect.disabled = true;
    return;
  }

  elements.micSelect.disabled = false;

  mics.forEach((mic, index) => {
    const option = document.createElement("option");
    option.value = mic.deviceId;
    option.textContent = mic.label || `Microphone ${index + 1}`;
    elements.micSelect.appendChild(option);
  });

  if (!selectedMicId || !mics.some((mic) => mic.deviceId === selectedMicId)) {
    selectedMicId = mics[0].deviceId;
  }

  elements.micSelect.value = selectedMicId;
}

async function switchMicrophone(deviceId) {
  if (!deviceId || !peerConnection) return;

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    deviceId: { exact: deviceId },
  };

  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  });
  const newTrack = newStream.getAudioTracks()[0];
  const oldTrack = mediaStream?.getAudioTracks?.()[0];

  if (audioSender) {
    await audioSender.replaceTrack(newTrack);
  } else {
    audioSender = peerConnection.addTrack(newTrack, newStream);
  }

  if (oldTrack) oldTrack.stop();

  mediaStream = newStream;

  if (audioContext) {
    audioContext.close();
    audioContext = null;
    analyser = null;
  }

  setupAudioAnalyser();
}

function initMicControls() {
  if (!elements.micSelect || !navigator.mediaDevices?.enumerateDevices) {
    if (elements.micSelect) elements.micSelect.disabled = true;
    if (elements.micRefresh) elements.micRefresh.disabled = true;
    return;
  }

  elements.micSelect.addEventListener("change", async (event) => {
    selectedMicId = event.target.value || null;
    if (isRunning) {
      await switchMicrophone(selectedMicId);
    }
  });

  if (elements.micRefresh) {
    elements.micRefresh.addEventListener("click", async () => {
      await refreshMicrophones(true);
    });
  }

  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshMicrophones(false);
  });

  refreshMicrophones(false);
}

function startRequestCounter() {
  requestCount = 0;
  requestsPerMinute = 0;
  updateRequestDisplay();

  requestCounterInterval = setInterval(() => {
    requestsPerMinute = 0;
    updateRequestDisplay();
  }, 60000);
}

/**
 * Arrête le compteur de requêtes
 */
function stopRequestCounter() {
  if (requestCounterInterval) {
    clearInterval(requestCounterInterval);
    requestCounterInterval = null;
  }
}

/**
 * Incrémente le compteur de requêtes
 */
function incrementRequestCount() {
  requestCount++;
  requestsPerMinute++;
  updateRequestDisplay();
}

/**
 * Met à jour l'affichage du compteur
 */
function updateRequestDisplay() {
  const reqPerMin = document.getElementById("reqPerMin");
  const reqTotal = document.getElementById("reqTotal");
  if (reqPerMin) reqPerMin.textContent = requestsPerMinute;
  if (reqTotal) reqTotal.textContent = requestCount;
}

// ==========================================
// Main Functions
// ==========================================

/**
 * Démarre la session de traduction temps réel via WebRTC
 */
async function startRealtime() {
  if (isRunning) return;

  try {
    isRunning = true;
    updateStatus("connecting", "Connexion en cours...");
    elements.startBtn.disabled = true;

    // 1. Initialiser WebRTC
    showToast("Connexion WebRTC...", "info");
    await setupWebRTC();
    await listMicrophones();

    // 2. Démarrer l'analyse audio locale (pour l'affichage)
    setupAudioAnalyser();

    // 3. Démarrer le compteur de requêtes
    startRequestCounter();

    // 4. Programmer la rotation de session
    scheduleSessionRotation();

    // Success
    updateStatus("connected", "Connecté - Traduction active");
    elements.stopBtn.disabled = false;
    elements.audioLevelContainer.style.display = "block";
    showToast("Traduction démarrée !", "success");
  } catch (error) {
    console.error("Erreur démarrage:", error);
    showToast(`Erreur: ${error.message}`, "error");
    updateStatus("error", "Erreur de connexion");
    cleanup();
    elements.startBtn.disabled = false;
    isRunning = false;
  }
}

/**
 * Arrête la session de traduction
 */
function stopRealtime() {
  exportHistory();
  cleanup();
  isRunning = false;
  updateStatus("disconnected", "Arrêté");
  elements.startBtn.disabled = false;
  elements.stopBtn.disabled = true;
  elements.audioLevelContainer.style.display = "none";
  showToast("Traduction arrêtée", "warning");
}

// ==========================================
// WebRTC Setup
// ==========================================

/**
 * Configure la connexion WebRTC avec l'API Realtime
 */
async function setupWebRTC() {
  // Créer une peer connection
  peerConnection = new RTCPeerConnection();

  // Pas de sortie audio (texte uniquement)
  peerConnection.ontrack = () => {
    // Ignorer les pistes audio entrantes
  };
  // Obtenir l'accès au microphone
  if (!selectedMicId && elements.micSelect?.value) {
    selectedMicId = elements.micSelect.value;
  }

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (selectedMicId) {
    audioConstraints.deviceId = { exact: selectedMicId };
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  });

  // Ajouter la piste audio locale
  audioSender = peerConnection.addTrack(
    mediaStream.getTracks()[0],
    mediaStream,
  );

  // Créer le data channel pour les événements
  dataChannel = peerConnection.createDataChannel("oai-events");

  dataChannel.onopen = () => {
    console.log("✅ DataChannel ouvert");
  };

  dataChannel.onmessage = handleRealtimeEvent;

  dataChannel.onerror = (error) => {
    console.error("❌ DataChannel erreur:", error);
  };

  dataChannel.onclose = () => {
    console.log("📴 DataChannel fermé");
    if (isRunning) {
      scheduleReconnect();
    }
  };

  // Gérer la déconnexion
  peerConnection.onconnectionstatechange = () => {
    console.log("📡 État connexion:", peerConnection.connectionState);
    if (
      peerConnection.connectionState === "failed" ||
      peerConnection.connectionState === "disconnected"
    ) {
      if (isRunning) {
        scheduleReconnect();
      }
    }
  };

  // Créer l'offre SDP
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Envoyer l'offre au serveur et recevoir la réponse
  const response = await fetch("/session", {
    method: "POST",
    body: offer.sdp,
    headers: {
      "Content-Type": "application/sdp",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erreur session: ${errorText}`);
  }

  const answerSdp = await response.text();

  // Définir la description distante
  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  console.log("✅ Connexion WebRTC établie");
}

/**
 * Demande une réponse texte au modèle
 */
let clientRequestSeq = 0;
let lastClientRequestId = null;
let pendingClientResponse = false;
const clientResponseIds = new Set();
let commitCounter = 0;
let lastRequestCommitCounter = 0;
let lastCommittedItemId = null;
const CONTEXT_ITEMS = 20; // Nombre de traductions précédentes à injecter comme contexte texte
const requestCommitMap = new Map();
const responseCommitMap = new Map();
const commitConsumed = new Map();

function requestTextResponse() {
  if (!dataChannel || dataChannel.readyState !== "open") {
    console.warn("DataChannel non disponible");
    return;
  }

  const requestId = `client_${Date.now()}_${clientRequestSeq++}`;
  lastClientRequestId = requestId;
  pendingClientResponse = true;
  lastRequestCommitCounter = commitCounter;
  requestCommitMap.set(requestId, lastRequestCommitCounter);

  const response = {
    conversation: "none",
    output_modalities: ["text"],
    metadata: {
      source: "client",
      request_id: requestId,
      commit_seq: String(lastRequestCommitCounter),
      commit_item_id: lastCommittedItemId || "",
    },
  };

  // Construire l'input : contexte texte des dernières traductions + audio courant uniquement
  // (envoyer plusieurs item_reference audio ferait retraduire les segments précédents → doublons)
  if (lastCommittedItemId) {
    const inputItems = [];

    const recentTranslations = subtitles.slice(-CONTEXT_ITEMS);
    if (recentTranslations.length > 0) {
      const contextText = recentTranslations
        .map((s) => `- ${s.text}`)
        .join("\n");
      inputItems.push({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Contexte (déjà traduit, ne pas répéter) :\n${contextText}`,
          },
        ],
      });
    }

    inputItems.push({ type: "item_reference", id: lastCommittedItemId });
    response.input = inputItems;
  }

  const event = {
    type: "response.create",
    response,
  };

  dataChannel.send(JSON.stringify(event));
  console.log("Request sent");
}

function maybeRequestResponse() {
  if (awaitingResponse) return;
  awaitingResponse = true;
  requestTextResponse();
}

// ==========================================
// Audio Analysis (for visual feedback only)
// ==========================================

/**
 * Configure l'analyseur de niveau audio (affichage uniquement)
 */
function setupAudioAnalyser() {
  if (!mediaStream) return;

  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(analyser);

  updateAudioLevel();
}

/**
 * Met à jour l'indicateur de niveau audio
 */
function updateAudioLevel() {
  if (!analyser || !isRunning) return;

  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(dataArray);

  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const sample = (dataArray[i] - 128) / 128;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / dataArray.length);
  const db = rms > 0 ? 20 * Math.log10(rms) : -60;
  const level = dbToLevel(db);

  // Mettre à jour la barre de niveau
  elements.audioLevel.style.width = `${level}%`;

  // Mettre à jour le panneau VAD
  const levelBar = document.getElementById("vadLevelBar");
  const levelValue = document.getElementById("audioLevelValue");
  if (levelBar) levelBar.style.width = `${level}%`;
  if (levelValue) levelValue.textContent = Math.round(level);

  requestAnimationFrame(updateAudioLevel);
}

function dbToLevel(db) {
  const minDb = -60;
  const clampedDb = Math.max(minDb, Math.min(0, db));
  return Math.round(((clampedDb - minDb) / (0 - minDb)) * 100);
}

// ==========================================
// Event Handling
// ==========================================

let vadDetectionCount = 0;
let awaitingResponse = false;
let responseHasOutputText = false;
let responseHasContentPart = false;
let lastTranslationText = "";
let lastTranslationAt = 0;
let pendingFinalText = "";
let deferredFinalText = "";

function resetResponseBuffers() {
  currentLine = "";
  responseHasOutputText = false;
  responseHasContentPart = false;
  pendingFinalText = "";
}

function maybeFlushDeferredFinal() {
  if (isSpeaking) return;
  if (awaitingResponse) return;
  if (!deferredFinalText) return;

  finalizeTranslation(deferredFinalText);
  deferredFinalText = "";
}

function finalizeTranslation(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  // Supprimer les "..." de fin produits par le modèle sur phrase incomplète
  const cleaned = trimmed.replace(/\.{2,}\s*$/, "").trimEnd();
  if (!cleaned) return;

  // Ignorer les sorties trop courtes pour être une vraie traduction (bruit, silence détecté)
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2 && cleaned.length < 8) return;

  const now = Date.now();
  if (cleaned === lastTranslationText && now - lastTranslationAt < 8000) {
    return;
  }

  const normalizeTranslation = (value) =>
    value
      .toLowerCase()
      .replace(/[\t\n\r]+/g, " ")
      .replace(/[.,!?;:'"()[\]{}-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const lastSubtitle = subtitles[subtitles.length - 1];
  if (lastSubtitle) {
    const recent = now - lastSubtitle.timestamp < 6000;
    const nextNorm = normalizeTranslation(cleaned);
    const lastNorm = normalizeTranslation(lastSubtitle.text);
    const sameOrExt =
      nextNorm === lastNorm ||
      nextNorm.startsWith(lastNorm) ||
      lastNorm.startsWith(nextNorm);

    if (recent && sameOrExt) {
      if (cleaned.length > lastSubtitle.text.length) {
        lastSubtitle.text = cleaned;
        updateHistory();
        renderSubtitles();
      }
      lastTranslationText = cleaned;
      lastTranslationAt = now;
      return;
    }
  }

  lastTranslationText = cleaned;
  lastTranslationAt = now;
  console.log("TRADUCTION:", cleaned);

  addSubtitle(cleaned);
  renderSubtitles();
}

function stopPrompteurScroll() {
  if (prompteurScrollRaf) {
    cancelAnimationFrame(prompteurScrollRaf);
    prompteurScrollRaf = null;
  }
  prompteurScrollY = 0;
  prompteurListEl = null;
  prompteurSeenKeys.clear();
}

function ensurePrompteurList(container) {
  if (prompteurListEl) return;
  container.innerHTML = "";
  prompteurListEl = document.createElement("div");
  prompteurListEl.className = "prompteur-list";
  container.appendChild(prompteurListEl);
  prompteurScrollY = container.clientHeight;
}

function startPrompteurAutoScroll() {
  if (!IS_PROMPTEUR) return;
  if (prompteurScrollRaf) return;

  const tick = () => {
    const container = elements.subtitlesContainer;
    if (!container || !prompteurListEl) return;

    const blockHeight = prompteurListEl.offsetHeight;
    if (blockHeight > 0) {
      prompteurScrollY -= prompteurScrollSpeed;
      const contentBottom = prompteurScrollY + blockHeight;
      if (contentBottom < 0) {
        prompteurListEl.innerHTML = "";
        prompteurSeenKeys.clear();
        prompteurScrollY = container.clientHeight;
      }
    } else {
      prompteurScrollY -= prompteurScrollSpeed;
      if (prompteurScrollY < -container.clientHeight) {
        prompteurScrollY = container.clientHeight;
      }
    }

    prompteurListEl.style.transform = `translateY(${prompteurScrollY}px)`;
    prompteurScrollRaf = requestAnimationFrame(tick);
  };

  prompteurScrollRaf = requestAnimationFrame(tick);
}

function renderPrompteurList(container, items) {
  ensurePrompteurList(container);

  items.forEach((sub) => {
    if (prompteurSeenKeys.has(sub.timestamp)) return;
    const div = document.createElement("div");
    div.className = "subtitle final";
    div.textContent = sub.text;
    prompteurListEl.appendChild(div);
    prompteurSeenKeys.add(sub.timestamp);
  });

  startPrompteurAutoScroll();
}

/**
 * Gère les événements reçus via DataChannel
 */
function handleRealtimeEvent(event) {
  try {
    const msg = JSON.parse(event.data);

    // Log tous les événements pour debug
    console.log("📨", msg.type, msg);

    // Session créée
    if (msg.type === "session.created") {
      console.log("✅ Session Realtime créée");
      showToast("Session connectée", "success");
      sessionReady = true;
      maybeEnableVadUpdates(msg.session);
      sendVadUpdate();
    }

    // Session mise à jour
    if (msg.type === "session.updated") {
      console.log("🔄 Session configurée");
      sessionReady = true;
      maybeEnableVadUpdates(msg.session);
    }

    if (msg.type === "response.created") {
      const responseMeta = msg.response?.metadata;
      const isClientResponse =
        responseMeta?.source === "client" &&
        responseMeta?.request_id === lastClientRequestId;

      if (isClientResponse) {
        pendingClientResponse = false;
        if (msg.response?.id) {
          clientResponseIds.add(msg.response.id);
          const commitId = responseMeta?.request_id
            ? (requestCommitMap.get(responseMeta.request_id) ??
              lastRequestCommitCounter)
            : lastRequestCommitCounter;
          responseCommitMap.set(msg.response.id, commitId);
        }
        awaitingResponse = true;
        resetResponseBuffers();
      } else {
        return;
      }
    }

    const responseId = msg.response_id || msg.response?.id;
    if (responseId && !clientResponseIds.has(responseId)) {
      return;
    }

    // ========== DÉTECTION VOCALE (Server VAD) ==========

    if (msg.type === "input_audio_buffer.speech_started") {
      console.log("🎙️ Parole détectée...");
      isSpeaking = true;
      vadDetectionCount++;

      const indicator = document.getElementById("vadIndicator");
      if (indicator) {
        indicator.style.background = "#2ecc71";
        indicator.style.boxShadow = "0 0 10px 3px rgba(46, 204, 113, 0.5)";
      }

      const detectionsEl = document.getElementById("vadDetections");
      if (detectionsEl) detectionsEl.textContent = vadDetectionCount;
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      console.log("🎙️ Fin de parole");
      isSpeaking = false;

      const indicator = document.getElementById("vadIndicator");
      if (indicator) {
        indicator.style.background = "#555";
        indicator.style.boxShadow = "none";
      }

      maybeFlushDeferredFinal();
    }

    if (msg.type === "input_audio_buffer.committed") {
      console.log("🎙️ Audio envoyé pour traitement...");
      lastCommittedItemId = msg.item_id || null;
      commitCounter += 1;
      commitConsumed.set(commitCounter, false);
      const pruneBefore = commitCounter - 10;
      for (const key of commitConsumed.keys()) {
        if (key < pruneBefore) {
          commitConsumed.delete(key);
        }
      }
      incrementRequestCount();
      maybeRequestResponse();
    }

    // ========== TRANSCRIPTION DE L'AUDIO D'ENTRÉE ==========

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      console.log("🎤 Source détectée:", msg.transcript?.substring(0, 100));
    }

    // ========== TRADUCTION (RÉPONSE DU MODÈLE) ==========

    // Response text delta - accumulate
    if (msg.type === "response.text.delta") {
      if (!responseHasOutputText && !responseHasContentPart) {
        currentLine += msg.delta || "";
      }
    }

    // Response text (output) delta
    if (msg.type === "response.output_text.delta") {
      if (!responseHasOutputText) currentLine = ""; // discard any text.delta accumulation
      responseHasOutputText = true;
      currentLine += msg.delta || "";
    }

    // Response text (output) done - display
    if (msg.type === "response.output_text.done") {
      responseHasOutputText = true;
      pendingFinalText = msg.text || currentLine;
    }

    // Audio transcript delta
    if (msg.type === "response.audio_transcript.delta") {
      if (!responseHasOutputText && !responseHasContentPart) {
        currentLine += msg.delta || "";
      }
    }

    if (msg.type === "response.audio_transcript.done") {
      if (!responseHasOutputText && !responseHasContentPart) {
        pendingFinalText = msg.transcript || currentLine;
      }
    }

    if (msg.type === "response.output_audio_transcript.delta") {
      if (!responseHasOutputText && !responseHasContentPart) {
        currentLine += msg.delta || "";
      }
    }

    if (msg.type === "response.output_audio_transcript.done") {
      if (!responseHasOutputText && !responseHasContentPart) {
        pendingFinalText = msg.transcript || currentLine;
      }
    }

    if (msg.type === "response.content_part.delta") {
      responseHasContentPart = true;
      if (msg.delta?.text && !responseHasOutputText) {
        currentLine += msg.delta.text;
      }
    }

    if (msg.type === "response.content_part.done") {
      responseHasContentPart = true;
      if (!responseHasOutputText) {
        pendingFinalText = msg.part?.text || currentLine;
      }
    }

    // Réponse terminée
    if (msg.type === "response.done") {
      awaitingResponse = false;
      const wasCancelled =
        msg.response?.status === "cancelled" ||
        msg.response?.status_details?.type === "cancelled";
      const finalText = pendingFinalText || currentLine;
      const trimmedFinal = (finalText || "").trim();
      const commitId = responseId ? responseCommitMap.get(responseId) : null;
      const alreadyConsumed = commitId ? commitConsumed.get(commitId) : false;
      if (wasCancelled && !finalText.trim()) {
        resetResponseBuffers();
        console.log("ðŸ“¦ RÃ©ponse annulÃ©e (vide)");
        if (responseId) {
          clientResponseIds.delete(responseId);
          responseCommitMap.delete(responseId);
        }
        maybeFlushDeferredFinal();
        return;
      }
      if (alreadyConsumed && trimmedFinal) {
        resetResponseBuffers();
        if (responseId) {
          clientResponseIds.delete(responseId);
          responseCommitMap.delete(responseId);
        }
        maybeFlushDeferredFinal();
        return;
      }
      if (commitId && trimmedFinal) {
        commitConsumed.set(commitId, true);
      }
      if (isSpeaking) {
        deferredFinalText = finalText;
      } else {
        deferredFinalText = "";
        finalizeTranslation(finalText);
      }
      resetResponseBuffers();
      if (responseId) {
        clientResponseIds.delete(responseId);
        responseCommitMap.delete(responseId);
      }
      console.log("📦 Réponse complète");
      maybeFlushDeferredFinal();
    }

    // Gestion des erreurs
    if (msg.type === "error") {
      console.error("❌ Erreur Realtime:", msg.error);
      const errorMsg = msg.error?.message || JSON.stringify(msg.error);
      if (
        !vadUpdateSupported &&
        (msg.error?.param === "session.turn_detection" ||
          msg.error?.param === "session")
      ) {
        return;
      }
      if (
        msg.error?.code === "unknown_parameter" ||
        msg.error?.code === "missing_required_parameter"
      ) {
        if (
          msg.error?.param === "session.turn_detection" ||
          msg.error?.param === "session"
        ) {
          setVadUpdateSupported(false);
          showToast("VAD update unsupported", "warning");
          return;
        }
      }
      if (msg.error?.code === "conversation_already_has_active_response") {
        awaitingResponse = true;
        return;
      }
      awaitingResponse = false;

      // Détecter le rate limit
      if (
        errorMsg.toLowerCase().includes("rate limit") ||
        errorMsg.toLowerCase().includes("rate_limit") ||
        errorMsg.toLowerCase().includes("too many requests") ||
        msg.error?.code === "rate_limit_exceeded"
      ) {
        showRateLimitAlert();
      } else {
        showToast(`Erreur: ${errorMsg}`, "error");
      }
    }
  } catch (error) {
    console.error("❌ Erreur parsing event:", error);
    console.error("Raw data:", event.data);
  }
}

// ==========================================
// Subtitles Management
// ==========================================

/**
 * Ajoute un sous-titre validé
 */
function addSubtitle(text) {
  const subtitle = {
    text,
    timestamp: Date.now(),
  };

  subtitles.push(subtitle);

  // Mettre à jour l'historique
  updateHistory();
}

/**
 * Rendu des sous-titres
 */
function renderSubtitles() {
  const container = elements.subtitlesContainer;

  const maxItems = IS_PROMPTEUR
    ? CONFIG.MAX_PROMPTEUR_ITEMS
    : CONFIG.MAX_DISPLAYED_SUBTITLES;

  const recentSubtitles = subtitles
    .slice(-maxItems)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (IS_PROMPTEUR) {
    renderPrompteurList(container, recentSubtitles);
    return;
  }

  container.innerHTML = "";

  if (subtitles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = isRunning
      ? "En attente de parole..."
      : 'Cliquez sur "Démarrer" pour commencer';
    container.appendChild(empty);
    return;
  }

  recentSubtitles.forEach((sub) => {
    const div = document.createElement("div");
    div.className = "subtitle final";

    div.textContent = sub.text;
    container.appendChild(div);
  });

  container.scrollTop = container.scrollHeight;
}

/**
 * Met à jour le panneau historique
 */
function updateHistory() {
  const container = elements.historyContent;
  container.innerHTML = "";

  subtitles.forEach((sub) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatTime(sub.timestamp);

    const text = document.createElement("span");
    text.className = "history-text";
    text.textContent = sub.text;

    item.appendChild(time);
    item.appendChild(text);
    container.appendChild(item);
  });

  container.scrollTop = container.scrollHeight;
}

/**
 * Exporte l'historique en fichier texte
 */
function exportHistory() {
  if (subtitles.length === 0) {
    showToast("Aucun historique à exporter", "warning");
    return;
  }

  const content = subtitles
    .map((sub) => {
      return `[${formatTime(sub.timestamp)}] ${sub.text}`;
    })
    .join("\n");

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `traduction-${formatDate(Date.now())}.txt`;
  a.click();

  URL.revokeObjectURL(url);
  showToast("Historique exporté !", "success");
}

// ==========================================
// Reconnection Logic
// ==========================================

/**
 * Programme une reconnexion automatique
 */
function scheduleReconnect() {
  console.warn("⚠️ Reconnexion programmée...");
  showToast("Connexion perdue, reconnexion...", "warning");
  updateStatus("connecting", "Reconnexion...");

  cleanup(false);

  reconnectTimer = setTimeout(async () => {
    try {
      await setupWebRTC();
      setupAudioAnalyser();
      scheduleSessionRotation();
      updateStatus("connected", "Reconnecté !");
      showToast("Reconnexion réussie !", "success");
    } catch (error) {
      console.error("Erreur reconnexion:", error);
      showToast("Échec reconnexion, nouvelle tentative...", "error");
      scheduleReconnect();
    }
  }, CONFIG.RECONNECT_DELAY_MS);
}

/**
 * Programme la rotation de session
 */
function scheduleSessionRotation() {
  clearTimeout(sessionRotationTimer);

  sessionRotationTimer = setTimeout(() => {
    console.log("🔄 Rotation de session...");
    showToast("Renouvellement de session...", "info");

    cleanup(false);
    startRealtime();
  }, CONFIG.SESSION_ROTATION_MS);

  updateSessionInfo();
}

/**
 * Met à jour l'info de session affichée
 */
function updateSessionInfo() {
  if (!isRunning) {
    elements.sessionInfo.textContent = "";
    return;
  }

  const remaining = Math.ceil(CONFIG.SESSION_ROTATION_MS / 60000);
  elements.sessionInfo.textContent = `Rotation dans ~${remaining} min`;
}

// ==========================================
// Cleanup
// ==========================================

/**
 * Nettoie toutes les ressources
 */
function cleanup(resetRunning = true) {
  clearTimeout(reconnectTimer);
  clearTimeout(sessionRotationTimer);

  stopRequestCounter();
  stopPrompteurScroll();

  // DataChannel
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  // PeerConnection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  audioSender = null;

  // Media stream
  if (resetRunning && mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  // Audio context
  if (resetRunning && audioContext) {
    audioContext.close();
    audioContext = null;
    analyser = null;
  }

  // Reset VAD indicator
  const indicator = document.getElementById("vadIndicator");
  if (indicator) {
    indicator.style.background = "#555";
    indicator.style.boxShadow = "none";
  }

  isSpeaking = false;
  currentLine = "";
  awaitingResponse = false;
  deferredFinalText = "";
  sessionReady = false;
  vadUpdateSupported = false;
  vadSupportChecked = false;

  if (resetRunning) {
    isRunning = false;
    vadDetectionCount = 0;
    const detectionsEl = document.getElementById("vadDetections");
    if (detectionsEl) detectionsEl.textContent = "0";
  }
}

// ==========================================
// UI Helpers
// ==========================================

/**
 * Met à jour l'indicateur de statut
 */
function updateStatus(status, text) {
  elements.statusText.textContent = text;

  elements.statusDot.classList.remove("connected", "connecting", "error");

  switch (status) {
    case "connected":
      elements.statusDot.classList.add("connected");
      break;
    case "connecting":
      elements.statusDot.classList.add("connecting");
      break;
    case "error":
      elements.statusDot.classList.add("error");
      break;
  }
}

/**
 * Affiche une alerte de rate limit
 */
function showRateLimitAlert() {
  stopRealtime();

  const overlay = document.createElement("div");
  overlay.id = "rateLimitOverlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
  `;

  const alertBox = document.createElement("div");
  alertBox.style.cssText = `
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border: 2px solid #e74c3c;
    border-radius: 16px;
    padding: 40px;
    max-width: 500px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(231, 76, 60, 0.3);
  `;

  alertBox.innerHTML = `
    <div style="font-size: 60px; margin-bottom: 20px;">⚠️</div>
    <h2 style="color: #e74c3c; margin: 0 0 15px 0; font-size: 24px;">Rate Limit Dépassé</h2>
    <p style="color: #ccc; margin: 0 0 20px 0; line-height: 1.6;">
      Vous avez atteint la limite de requêtes de l'API OpenAI.<br>
      Veuillez patienter quelques minutes avant de réessayer.
    </p>
    <div style="background: #2d2d44; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
      <p style="color: #f39c12; margin: 0; font-size: 14px;">
        💡 Conseil: Parlez moins fréquemment ou attendez des pauses plus longues entre les phrases.
      </p>
    </div>
    <button id="closeRateLimitAlert" style="
      background: #e74c3c;
      color: white;
      border: none;
      padding: 12px 30px;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: background 0.3s;
    ">Compris</button>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  document
    .getElementById("closeRateLimitAlert")
    .addEventListener("click", () => {
      overlay.remove();
    });

  const escHandler = (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);
}

/**
 * Affiche une notification toast
 */
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Formate un timestamp en heure
 */
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Formate un timestamp en date pour le nom de fichier
 */
function formatDate(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
}
