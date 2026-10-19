import express from "express";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import {
  createRealtimeCall,
  createTranslateCall,
  OPENAI_REALTIME_MODEL,
  OPENAI_TRANSLATE_MODEL,
} from "./openai.js";
import { attachGeminiProxy, GEMINI_MODEL } from "./gemini.js";
import { normalizeSettings } from "./settings.js";
import { buildInstructions, SOURCE_LANGUAGES } from "./prompt.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(join(__dirname, "../public")));

/**
 * Bloque les appels venant d'un autre site web (sinon n'importe quelle page
 * ouverte dans le navigateur pourrait consommer les crédits API).
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // outils locaux (curl…)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

app.get("/api/config", (req, res) => {
  res.json({
    providers: {
      "openai-translate": { available: !!process.env.OPENAI_API_KEY, model: OPENAI_TRANSLATE_MODEL },
      "openai-realtime": { available: !!process.env.OPENAI_API_KEY, model: OPENAI_REALTIME_MODEL },
      gemini: { available: !!process.env.GEMINI_API_KEY, model: GEMINI_MODEL },
    },
    sourceLanguages: Object.keys(SOURCE_LANGUAGES),
  });
});

app.get("/api/instructions", (req, res) => {
  res.json({ instructions: buildInstructions(String(req.query.sourceLang || "gujarati")) });
});

// Échange SDP WebRTC pour OpenAI. Corps : { sdp, mode: "realtime" | "translate", settings }
app.post("/session/openai", async (req, res) => {
  if (!isAllowedOrigin(req)) return res.status(403).json({ error: "Origine refusée" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY non configurée dans .env" });

  const { sdp, mode } = req.body || {};
  if (typeof sdp !== "string" || !sdp.startsWith("v=")) {
    return res.status(400).json({ error: "SDP manquant ou invalide" });
  }

  const settings = normalizeSettings(req.body.settings);
  const started = Date.now();
  try {
    const answer =
      mode === "translate"
        ? await createTranslateCall(apiKey, sdp, settings)
        : await createRealtimeCall(apiKey, sdp, settings);
    console.log(`✅ Session OpenAI ${mode} créée en ${Date.now() - started} ms`);
    res.type("application/sdp").send(answer);
  } catch (error) {
    console.error(`❌ Session OpenAI ${mode}:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
  });
});

const server = createServer(app);
attachGeminiProxy(server, { isAllowedOrigin });

server.listen(PORT, HOST, () => {
  const ok = (v) => (v ? "✅ configurée" : "❌ absente");
  console.log(`
🚀 Traduction temps réel démarrée

   Prompteur :  http://localhost:${PORT}/prompteur.html
   Simple :     http://localhost:${PORT}/

   Clé OpenAI : ${ok(process.env.OPENAI_API_KEY)}  (${OPENAI_TRANSLATE_MODEL} / ${OPENAI_REALTIME_MODEL})
   Clé Gemini : ${ok(process.env.GEMINI_API_KEY)}  (${GEMINI_MODEL})
`);
});
