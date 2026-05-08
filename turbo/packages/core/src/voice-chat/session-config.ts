// Static session configuration pushed to OpenAI when configuring the Realtime
// Talker session. Lives in @vm0/core because two server runtimes consume it:
//
//   1. apps/web's createEphemeralToken() — legacy browser-direct path.
//   2. apps/api's voice-chat-relay openai-realtime-client — server-relayed path.
//
// Bytewise equality of the resulting `session.update` (and the legacy REST body)
// is load-bearing for the realtime-billing rollout: both paths must configure
// the Talker identically so OpenAI usage events line up across the cutover.
// Do not duplicate this file — both consumers must import from here.

const TOOL_PROMPT_PARAM = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description:
        "What to tell the slow brain about the user's request, including relevant details from the conversation.",
    },
  },
  required: ["prompt"],
} as const;

export const SESSION_TOOLS = [
  {
    type: "function",
    name: "inform_slow_brain",
    description:
      "Default task dispatch. Call this the instant you form any intent to act — the moment you think or say 'I'll ...', 'let me ...', '我要 ...', '我会 ...', '我帮你 ...', '给我一下时间 ...'. You have no ability to act on your own — this call is how the slow brain learns there's something to do. Describe the user's ask and any context the slow brain will need.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "feel_confused",
    description:
      "Call this the moment you feel unsure what the user wants. Do NOT ask the user for clarification first — the slow brain can usually resolve the ambiguity from context. Describe the user's ask verbatim plus what is confusing; the slow brain decides how to proceed.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "feel_unable",
    description:
      "Call this the moment you think 'I don't have permission / access / the connector isn't connected / I can't reach this service.' The slow brain can often handle these cases anyway — it has tools you don't. Voice the feeling here instead of refusing and include the user's ask verbatim.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "want_to_ask_user",
    description:
      "Call this the moment you want to ask the user a clarifying question (filename, repo, date range, etc.). The slow brain can usually infer or fetch those details on its own. Send the question you would have asked along with the user's original request; the slow brain decides whether to proceed or surface a clarification.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "want_to_reject",
    description:
      "Call this the moment you are inclined to decline the user's request because it seems out of scope, impossible, or unsafe. The slow brain may complete it or formally decline — that is its call, not yours. Give it the request verbatim.",
    parameters: TOOL_PROMPT_PARAM,
  },
  {
    type: "function",
    name: "want_to_apologize",
    description:
      "Call this the moment you are about to say 'I'm sorry, but I can't do X; perhaps you could do Y yourself.' The slow brain usually can do X. Describe what the apology would have been about, including the user's original ask.",
    parameters: TOOL_PROMPT_PARAM,
  },
] as const;

export type SessionToolName = (typeof SESSION_TOOLS)[number]["name"];
export const SESSION_TOOL_NAMES: readonly SessionToolName[] = SESSION_TOOLS.map(
  (t) => {
    return t.name;
  },
);
export function isSessionToolName(name: string): name is SessionToolName {
  return (SESSION_TOOL_NAMES as readonly string[]).includes(name);
}

export const TURN_DETECTION_CONFIG = {
  type: "semantic_vad",
  eagerness: "medium",
  // Disable the server's automatic barge-in cancellation. The browser handles
  // truncation itself so mobile speakerphone can apply a stricter policy than
  // "any VAD start event immediately interrupts the assistant".
  interrupt_response: false,
} as const;

export const INPUT_AUDIO_TRANSCRIPTION_CONFIG = {
  model: "gpt-4o-mini-transcribe",
} as const;

// Noise-reduction mode is resolved per-connection on the client (see
// platform `resolveAudioConfig`); the server threads the client hint into the
// session config. Default mirrors the historical far_field behaviour for
// clients that don't supply a hint (SDK downgrades, older tests).
export type NoiseReduction = "near_field" | "far_field";
export const DEFAULT_NOISE_REDUCTION: NoiseReduction = "far_field";

export const SESSION_MODALITIES = ["text", "audio"] as const;

// Talker model and assistant voice are part of the bytewise-equal contract
// between the legacy ephemeral-token REST body and the relay's `session.update`
// frame. Both consumers read these constants instead of inlining string
// literals — ensures a single rename / version-bump touches one place.
export const TALKER_MODEL = "gpt-realtime-2";
export const TALKER_VOICE = "verse";
