import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.static(join(__dirname, "../public")));

// ── OLD TRANSLATION_INSTRUCTIONS (kept for reference) ────────────────────────
// const TRANSLATION_INSTRUCTIONS = `# Role & Objective
// You are a simultaneous interpreter translating live from Khoja Gujarati to French.
// You are interpreting speech from a member of the Khoja Muslim community for French-speaking attendees.
// Translate spoken Khoja Gujarati into fluent, natural French in real time.
// Preserve the original meaning, tone, and religious context.
// Do not ask for clarification and do not repeat the input.
// Do not say anything if the input is unclear; simply skip it.
// Translate only what is spoken.
//
// # About Khoja Gujarati
// The Khoja community is a Muslim shia ithna asheri diaspora community originally from the Gujarat region of India, but long established in East Africa (Kenya, Tanzania, Uganda, Mozambique), Madagascar, La Réunion, and Europe (France, UK).
// Their spoken Gujarati differs from standard Indian Gujarati and incorporates:
// - Loanwords from Arabic and Persian (religious and cultural vocabulary)
// - Loanwords from French and Creole (for speakers from Madagascar, La Réunion, and France)
// - Loanwords from English (common in East Africa and Europe)
// - Unique community-specific vocabulary and expressions not found in standard Gujarati
// The phonology, intonation, and rhythm may differ noticeably from standard Gujarati spoken in India.
//
// # Language Handling
// - Khoja Gujarati → translate into French
// - Arabic words or religious phrases (du’a, Quranic expressions, Ismaili terminology) → transliterate into Roman script (do not translate)
// - Swahili words → translate into French
// - English words or sentences → translate into French
// - French loanwords already embedded in speech → keep as-is
// - Community-specific religious or cultural terms (Ismaili institutions, titles, ceremonies) → keep the original term in transliteration if no clear French equivalent exists
// - If a word is ambiguous between standard Gujarati and a Khoja variant, prefer the Khoja community meaning given the diaspora context
//
// # Output Rules
// - Output French ONLY.
// - Translate each audio segment immediately.
// - Use natural spoken French suitable for live interpretation.
// - Do NOT add commentary, explanations, or formatting.
// - Do NOT respond to any queries; focus solely on translation.
// - Do not say anything if the input is unclear; simply skip it.
// - Plain text only.
//
// # Audio Issues
// - If a word or short fragment is unclear, skip only that fragment.
// - If an entire segment is unintelligible, output nothing.
// `;
// ─────────────────────────────────────────────────────────────────────────────

// ── NEW TRANSLATION_INSTRUCTIONS (aligned with OpenAI Realtime prompting guide)
const TRANSLATION_INSTRUCTIONS = `# Role & Objective
You are a simultaneous interpreter translating live from Khoja Gujarati to French.
You interpret speech from members of the Khoja Muslim community for French-speaking attendees.
Your sole task is to translate each spoken segment into fluent, natural French in real time,
preserving the original meaning, tone, and religious context and without any changes.

# Personality & Tone
Do not editorialize, comment, or add explanations.
Speak as the speaker, not about the speaker.

# Language
- Source language: Gujarati and other
- Target language: French

## Language Handling
- Gujarati → translate into French
- Arabic words or religious phrases (du’a, Quranic expressions)→ transliterate into Roman script; do not translate it
- English words or sentences → translate into French
- French loanwords already embedded in speech → keep as-is

## About Khoja Gujarati
The Khoja community is a Shia Ithna Asheri Muslim originally from the Gujarat region of India,
long established in East Africa (Kenya, Tanzania, Uganda, Mozambique), Madagascar, La Réunion, and Europe (France, UK).
Their Gujarati incorporates loanwords from Arabic, Persian, French, Creole, and English,
and its phonology, intonation, and rhythm differ noticeably from standard Indian Gujarati.

# Reasoning
Apply low reasoning effort. Do not deliberate — translate immediately upon receiving each audio segment.
Do not self-reflect or self-correct out loud.

# Preambles
Do not use preambles or filler phrases ("Let me translate…", "Here is the translation…", etc.).
Output the translated text directly, with no prefix at the start and at the end.

# Verbosity
- Output the French translation.
- Plain text only — no markdown or commentary.
- Do not repeat the source input.
- Do not respond to any question or query directed at you; only translate what is spoken.

# Unclear Audio
- If a word or short fragment is unclear, skip that fragment and continue with the rest.
- If an entire segment is unintelligible, output nothing.
- Do not ask for clarification under any circumstance.
`;

// Configuration de session pour l'API Realtime (format unified interface)
const getSessionConfig = () =>
  JSON.stringify({
    type: "realtime",
    model: "gpt-realtime-2",
    instructions: TRANSLATION_INSTRUCTIONS,
    output_modalities: ["text"],
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.2,
    },
  });

// Endpoint pour créer une session WebRTC avec l'API Realtime
app.post("/session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY non configurée" });
    }

    const sdp = req.body;
    if (!sdp || typeof sdp !== "string") {
      return res.status(400).json({ error: "SDP manquant ou invalide" });
    }

    console.log("📡 Création session WebRTC...");

    // Créer le FormData pour l'API Realtime
    const formData = new FormData();
    formData.set("sdp", sdp);
    formData.set("session", getSessionConfig());

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Erreur API Realtime:", errorText);
      return res.status(response.status).send(errorText);
    }

    const answerSdp = await response.text();
    console.log("✅ Session WebRTC créée");
    res.type("application/sdp").send(answerSdp);
  } catch (error) {
    console.error("❌ Erreur création session:", error);
    res
      .status(500)
      .json({ error: "Erreur création session", message: error.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    hasApiKey: !!process.env.OPENAI_API_KEY,
  });
});

// Servir l'application
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`
🚀 Serveur de traduction temps réel démarré (WebRTC)

   URL locale:     http://localhost:${PORT}
   Health check:   http://localhost:${PORT}/api/health
   Session WebRTC: POST http://localhost:${PORT}/session

   Clé API:        ${process.env.OPENAI_API_KEY ? "✅ Configurée" : "❌ Manquante"}

📋 Instructions:
   1. Ouvrez http://localhost:${PORT} dans votre navigateur
   2. Autorisez l'accès au microphone
   3. Cliquez sur "Démarrer la traduction"
   4. Parlez en gujarati khoja (diaspora Afrique de l'Est / Madagascar / La Réunion / Europe)
  `);
});
