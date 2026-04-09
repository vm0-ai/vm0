import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("voice-chat:openai-token");

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/sessions";

interface EphemeralTokenResponse {
  client_secret: {
    value: string;
    expires_at: number;
  };
}

export async function createEphemeralToken(): Promise<EphemeralTokenResponse> {
  const apiKey = env().OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const response = await fetch(OPENAI_REALTIME_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-realtime-1.5",
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
