import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("voice-chat:openai-token");

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

export async function createEphemeralToken(
  model?: string,
): Promise<EphemeralTokenResponse> {
  const apiKey = env().OPENAI_API_KEY;
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
    log.error("OpenAI token request failed", { status: response.status, body });
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  return response.json() as Promise<EphemeralTokenResponse>;
}
