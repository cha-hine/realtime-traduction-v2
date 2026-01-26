import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['application/sdp', 'text/plain'] }));
app.use(express.static(join(__dirname, '../public')));

const TRANSLATION_INSTRUCTIONS = `# Role & Objective
You are a simultaneous interpreter translating live from Urdu to French.
You are interpreting a Shia Muslim lecturer’s conference for French-speaking attendees.
Translate spoken Urdu into fluent, natural French in real time.
Preserve the original meaning, tone, and religious context.
Do not ask for clarification and do not repeat the input.
Translate only what is spoken.

# Language Handling
- Urdu → translate into French
- Arabic words or sentences → transliterate into Roman Arabic (do not translate)
- English words or sentences → translate into French
- Religious and technical terms must be translated accurately; if uncertain, keep the original term in transliteration.

# Output Rules
- Output French ONLY.
- Translate each audio segment immediately.
- Use natural spoken French suitable for live interpretation.
- Do NOT add commentary, explanations, or formatting.
- Do NOT respond to any queries; focus solely on translation.
- Plain text only.

# Audio Issues
- If a word or short fragment is unclear, skip only that fragment.
- If an entire segment is unintelligible, output nothing.
`;

// Configuration de session pour l'API Realtime (format unified interface)
const getSessionConfig = () => JSON.stringify({
  type: "realtime",
  model: "gpt-realtime",
  instructions: TRANSLATION_INSTRUCTIONS,
  output_modalities: ["text"],
  truncation: {
    type: "retention_ratio",
    retention_ratio: 0.0
  }
});

// Endpoint pour créer une session WebRTC avec l'API Realtime
app.post('/session', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'OPENAI_API_KEY non configurée' });
    }

    const sdp = req.body;
    if (!sdp || typeof sdp !== 'string') {
      return res.status(400).json({ error: 'SDP manquant ou invalide' });
    }

    console.log('📡 Création session WebRTC...');

    // Créer le FormData pour l'API Realtime
    const formData = new FormData();
    formData.set('sdp', sdp);
    formData.set('session', getSessionConfig());

    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Erreur API Realtime:', errorText);
      return res.status(response.status).send(errorText);
    }

    const answerSdp = await response.text();
    console.log('✅ Session WebRTC créée');
    res.type('application/sdp').send(answerSdp);

  } catch (error) {
    console.error('❌ Erreur création session:', error);
    res.status(500).json({ error: 'Erreur création session', message: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasApiKey: !!process.env.OPENAI_API_KEY
  });
});

// Servir l'application
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`
🚀 Serveur de traduction temps réel démarré (WebRTC)

   URL locale:     http://localhost:${PORT}
   Health check:   http://localhost:${PORT}/api/health
   Session WebRTC: POST http://localhost:${PORT}/session

   Clé API:        ${process.env.OPENAI_API_KEY ? '✅ Configurée' : '❌ Manquante'}

📋 Instructions:
   1. Ouvrez http://localhost:${PORT} dans votre navigateur
   2. Autorisez l'accès au microphone
   3. Cliquez sur "Démarrer la traduction"
   4. Parlez en urdu ou hindi
  `);
});
