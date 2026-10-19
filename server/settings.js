import { buildInstructions, SOURCE_LANGUAGES } from "./prompt.js";

const MAX_INSTRUCTIONS = 20000;

const clampNum = (value, def, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

const oneOf = (value, allowed, def) => (allowed.includes(value) ? value : def);

/** Valide les réglages envoyés par le navigateur (jamais de confiance aveugle). */
export function normalizeSettings(raw = {}) {
  const vad = raw.vad || {};
  const sourceLang = oneOf(raw.sourceLang, Object.keys(SOURCE_LANGUAGES), "gujarati");
  const custom =
    typeof raw.instructions === "string" ? raw.instructions.trim().slice(0, MAX_INSTRUCTIONS) : "";

  return {
    sourceLang,
    // Instructions libres de l'utilisateur ; à défaut, le texte par défaut pour la langue.
    instructions: custom || buildInstructions(sourceLang),
    noiseReduction: oneOf(raw.noiseReduction, ["near_field", "far_field"], null),
    vad: {
      mode: oneOf(vad.mode, ["semantic", "server"], "semantic"),
      eagerness: oneOf(vad.eagerness, ["low", "medium", "high", "auto"], "high"),
      silenceMs: clampNum(vad.silenceMs, 400, 100, 2000),
      prefixMs: clampNum(vad.prefixMs, 200, 0, 1000),
      threshold: clampNum(vad.threshold, 0.5, 0.1, 0.95),
    },
  };
}
