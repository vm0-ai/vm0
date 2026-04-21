import { env } from "../../../env";

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/sessions";

const ALLOWED_MODELS = ["gpt-realtime", "gpt-realtime-mini"] as const;
type RealtimeModel = (typeof ALLOWED_MODELS)[number];

function resolveModel(input?: string): RealtimeModel {
  if (input && ALLOWED_MODELS.includes(input as RealtimeModel)) {
    return input as RealtimeModel;
  }
  return "gpt-realtime-mini";
}

interface EphemeralTokenResponse {
  client_secret: {
    value: string;
    expires_at: number;
  };
}

// Tagged error raised when the upstream OpenAI realtime session endpoint
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

export async function createEphemeralToken(
  model?: string,
): Promise<EphemeralTokenResponse> {
  const apiKey = env().OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const resolvedModel = resolveModel(model);

  const response = await fetch(OPENAI_REALTIME_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolvedModel,
      voice: "verse",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw createOpenAiTokenError(response.status, body);
  }

  return response.json() as Promise<EphemeralTokenResponse>;
}
