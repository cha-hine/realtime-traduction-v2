# Traduction Temps Réel - Urdu/Hindi → Français

Solution de traduction en temps réel utilisant l'API OpenAI Realtime et WebRTC.

## Fonctionnalités

- Traduction Urdu/Hindi → Français en temps réel
- Sous-titres synchronisés avec latence minimale (200-400ms)
- Reconnexion automatique
- Rotation de session automatique (avant expiration 60 min)
- Export de l'historique en fichier texte
- Interface responsive

## Architecture

```
Microphone
    ↓
WebRTC (RTCPeerConnection)
    ↓
OpenAI Realtime API (gpt-4o-mini-transcribe)
    ↓
Événements texte (delta + completed)
    ↓
Sous-titres synchronisés
```

## Prérequis

- Node.js 18+
- Clé API OpenAI avec accès à l'API Realtime
- Navigateur moderne (Chrome, Firefox, Edge)

## Installation

1. Clonez le projet et installez les dépendances :

```bash
npm install
```

2. Configurez votre clé API OpenAI :

```bash
cp .env.example .env
```

Éditez `.env` et ajoutez votre clé :

```
OPENAI_API_KEY=sk-votre-cle-api
```

3. Démarrez le serveur :

```bash
npm start
```

4. Ouvrez http://localhost:3000/prompteur.html dans votre navigateur

## Utilisation

1. Cliquez sur "Démarrer la traduction"
2. Autorisez l'accès au microphone
3. Parlez en urdu ou hindi
4. Les sous-titres en français apparaissent en temps réel

## Structure du projet

```
realtime-traduction-v2/
├── server/
│   └── index.js          # Serveur Express + endpoint token
├── public/
│   ├── index.html        # Page principale
├    ── prompteur.html    # Page principale
│   ├── styles.css        # Styles
│   └── app.js            # Client WebRTC
├── .env.example          # Exemple de configuration
├── .gitignore
├── package.json
└── README.md
```

## Coût estimé

~1-2 $ par heure d'utilisation (selon le volume de parole)

## Sécurité

- La clé API OpenAI n'est JAMAIS exposée côté client
- Un token éphémère est généré par le serveur pour chaque session
- Les tokens expirent après 60 minutes

## Dépannage

### Le microphone n'est pas détecté

- Vérifiez que vous utilisez HTTPS ou localhost
- Autorisez l'accès au microphone dans les paramètres du navigateur

### Erreur de connexion

- Vérifiez que votre clé API OpenAI est valide
- Vérifiez que vous avez accès à l'API Realtime

### La traduction ne démarre pas

- Ouvrez la console développeur (F12) pour voir les erreurs
- Vérifiez que le serveur est bien démarré

## License

MIT
