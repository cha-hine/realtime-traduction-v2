# Traduction temps réel — Majlis & séminaires → Français

Sous-titrage en direct (prompteur) de la parole (gujarati khoja, ourdou, hindi, arabe…) vers le français.

## Trois moteurs au choix

| Moteur | Transport | Instructions perso | Vitesse | Coût indicatif |
|---|---|---|---|---|
| **OpenAI Translate** (`gpt-realtime-translate`) | WebRTC | ❌ (langue détectée seule) | ⚡ le plus rapide : traduit en continu, sans attendre les pauses | 0,034 $/min ≈ 2 $/h |
| **OpenAI Realtime 2.1** (`gpt-realtime-2.1`) | WebRTC | ✅ | rapide : une traduction par phrase détectée | au token |
| **Gemini Live** (`gemini-3.8-live`) | WebSocket (relais local) | ✅ | rapide | au token |

Les instructions de traduction (contexte du majlis, orateur, thème, termes arabes à garder…) se modifient
dans le panneau **Instructions de traduction** et sont mémorisées dans le navigateur.

## Installation

```bash
npm install
cp .env.example .env   # puis renseigner OPENAI_API_KEY et/ou GEMINI_API_KEY
npm start
```

Ouvrir http://localhost:3000/prompteur.html (ou le port défini dans `.env`).

## Utilisation

1. ⚙ → choisir le moteur, la langue parlée et le micro.
2. **Démarrer**. Les phrases apparaissent mot à mot pendant la traduction.
3. Un réglage modifié pendant la séance s'applique avec **↻ Appliquer maintenant** : une nouvelle session
   est ouverte avant de fermer l'ancienne, donc sans coupure.
4. Flèches ← → ou pointeur de diapo (PageUp/PageDown) : vitesse de défilement.
5. **Arrêter** exporte automatiquement l'historique en `.txt`.

Conseil son : si le micro vient de la table de mixage, décocher « Filtrage du navigateur ».

## Architecture

```
server/
  index.js     Express : pages, /api/config, /session/openai (échange SDP WebRTC)
  openai.js    sessions gpt-realtime-2.1 et gpt-realtime-translate
  gemini.js    relais WebSocket /gemini ⇄ Gemini Live (reprise de session automatique)
  prompt.js    instructions par défaut selon la langue
  settings.js  validation des réglages reçus du navigateur
public/
  prompteur.html, index.html, styles.css
  js/main.js              interface, démarrage, reconnexion, rotation sans coupure
  js/audio.js             micro unique + niveau + PCM 16 kHz (Gemini)
  js/pcm-worklet.js       conversion audio pour Gemini
  js/transcript.js        segments, découpage en phrases, prompteur, historique
  js/providers/openai.js  OpenAI (WebRTC)
  js/providers/gemini.js  Gemini (WebSocket)
```

## Sécurité

- Les clés API restent sur le serveur (jamais envoyées au navigateur).
- Les appels venant d'un autre site web sont refusés.
- `HOST=127.0.0.1` dans `.env` interdit l'accès depuis le réseau local.

## Dépannage

- **Micro non détecté** : utiliser `localhost` ou HTTPS, autoriser le micro.
- **Gemini « clé manquante »** : ajouter `GEMINI_API_KEY` dans `.env` puis relancer.
- **Erreur de modèle Gemini** : changer `GEMINI_MODEL` dans `.env` (voir la liste des modèles Live chez Google).
- Console développeur (F12) pour le détail des erreurs. Tests d'affichage sans micro : `prompteur.html?debug`.
