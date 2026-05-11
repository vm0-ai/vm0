import {
  DEFAULT_NOISE_REDUCTION,
  INPUT_AUDIO_TRANSCRIPTION_CONFIG,
  SESSION_OUTPUT_MODALITIES,
  SESSION_TOOLS,
  TALKER_MODEL,
  TALKER_REASONING_CONFIG,
  TALKER_VOICE,
  TURN_DETECTION_CONFIG,
  type NoiseReduction,
} from "@vm0/core/voice-chat/session-config";

import { env } from "../../../env";

const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

interface EphemeralTokenResponse {
  client_secret: {
    value: string;
    expires_at: number;
  };
}

interface OpenAiClientSecretResponse {
  value: string;
  expires_at: number;
}

// Tagged error raised when the upstream OpenAI realtime client-secret endpoint
// responds with a non-ok status. The route handler uses `isOpenAiTokenError`
// to narrow the catch and map to HTTP 500 with the documented error body.
// Plain object + discriminant avoids `class`, which is disallowed by project lint rules.
const OPENAI_TOKEN_ERROR_TAG = "OpenAiTokenError" as const;

interface OpenAiTokenError extends Error {
  readonly name: typeof OPENAI_TOKEN_ERROR_TAG;
  readonly status: number;
  readonly body: string;
}

function createOpenAiTokenError(
  status: number,
  body: string,
): OpenAiTokenError {
  const err = new Error(`OpenAI API error: ${status}`) as Error & {
    name: typeof OPENAI_TOKEN_ERROR_TAG;
    status: number;
    body: string;
  };
  err.name = OPENAI_TOKEN_ERROR_TAG;
  err.status = status;
  err.body = body;
  return err;
}

export function isOpenAiTokenError(value: unknown): value is OpenAiTokenError {
  return (
    value instanceof Error &&
    (value as { name?: unknown }).name === OPENAI_TOKEN_ERROR_TAG
  );
}

export async function createEphemeralToken(options: {
  instructions: string;
  noiseReduction?: NoiseReduction;
  safetyIdentifier?: string;
}): Promise<EphemeralTokenResponse> {
  const apiKey = env().OPENAI_API_KEY;

  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
  if (options.safetyIdentifier) {
    headers.set("OpenAI-Safety-Identifier", options.safetyIdentifier);
  }

  const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: TALKER_MODEL,
        reasoning: TALKER_REASONING_CONFIG,
        output_modalities: SESSION_OUTPUT_MODALITIES,
        instructions: options.instructions,
        audio: {
          input: {
            transcription: INPUT_AUDIO_TRANSCRIPTION_CONFIG,
            noise_reduction: {
              type: options.noiseReduction ?? DEFAULT_NOISE_REDUCTION,
            },
            turn_detection: TURN_DETECTION_CONFIG,
          },
          output: {
            voice: TALKER_VOICE,
          },
        },
        tools: SESSION_TOOLS,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw createOpenAiTokenError(response.status, body);
  }

  const data = (await response.json()) as OpenAiClientSecretResponse;
  return {
    client_secret: {
      value: data.value,
      expires_at: data.expires_at,
    },
  };
}
