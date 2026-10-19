const OPENAI_API = "https://api.openai.com/v1";

export const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
export const OPENAI_TRANSLATE_MODEL =
  process.env.OPENAI_TRANSLATE_MODEL || "gpt-realtime-translate";

/**
 * Détection de fin de phrase (VAD) pour gpt-realtime.
 * create_response:false → le serveur ne lance PAS de réponse automatique :
 * c'est le client qui demande une traduction hors conversation par segment.
 * interrupt_response:false → une reprise de parole n'annule pas la traduction en cours.
 */
export function buildTurnDetection(vad) {
  const common = { create_response: false, interrupt_response: false };
  if (vad.mode === "server") {
    return {
      type: "server_vad",
      threshold: vad.threshold,
      prefix_padding_ms: vad.prefixMs,
      silence_duration_ms: vad.silenceMs,
      ...common,
    };
  }
  return { type: "semantic_vad", eagerness: vad.eagerness, ...common };
}

function realtimeSession({ instructions, vad, noiseReduction }) {
  return {
    type: "realtime",
    model: OPENAI_REALTIME_MODEL,
    instructions,
    output_modalities: ["text"],
    reasoning: { effort: "none" },
    audio: {
      input: {
        turn_detection: buildTurnDetection(vad),
        noise_reduction: noiseReduction ? { type: noiseReduction } : null,
      },
    },
    tracing: { workflow_name: "realtime-traduction-v2" },
  };
}

async function readError(response) {
  const text = await response.text();
  return `${response.status} ${text}`;
}

/** gpt-realtime : échange SDP direct via l'interface unifiée /realtime/calls. */
export async function createRealtimeCall(apiKey, sdp, settings) {
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(realtimeSession(settings)));

  const response = await fetch(`${OPENAI_API}/realtime/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.text();
}

/**
 * gpt-realtime-translate : traduction continue (sans attendre les pauses).
 * 1. secret client éphémère (la clé API reste sur le serveur)
 * 2. échange SDP sur /realtime/translations/calls
 */
export async function createTranslateCall(apiKey, sdp, { noiseReduction }) {
  const secretRes = await fetch(
    `${OPENAI_API}/realtime/translations/client_secrets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: OPENAI_TRANSLATE_MODEL,
          audio: {
            input: noiseReduction
              ? { noise_reduction: { type: noiseReduction } }
              : {},
            output: { language: "fr" },
          },
        },
      }),
    },
  );
  if (!secretRes.ok) throw new Error(await readError(secretRes));
  const secret = await secretRes.json();
  const clientSecret = secret.value || secret.client_secret?.value;
  if (!clientSecret) throw new Error("Secret client absent de la réponse");

  const response = await fetch(`${OPENAI_API}/realtime/translations/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: sdp,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.text();
}
