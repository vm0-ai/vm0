import "server-only";
import { env } from "../../../env";
import { logger } from "../../shared/logger";
import {
  REASONER_SYSTEM_PROMPT,
  buildReasonerUserPrompt,
} from "./reasoner-prompts";

const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4.5";
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 400;
const TEMPERATURE = 0.2;

const log = logger("zero:voice-chat-candidate:reasoner");

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface CallReasonerParams {
  agentSystemPrompt: string;
  currentContext: string | null;
  newItems: Array<{ seq: number; role: string; content: string | null }>;
  pendingTasks: Array<{ id: string; status: string; prompt: string }>;
}

export async function callReasoner(
  params: CallReasonerParams,
): Promise<string | null> {
  const { OPENROUTER_API_KEY } = env();
  if (!OPENROUTER_API_KEY) {
    log.warn("OPENROUTER_API_KEY not configured, skipping reasoner call");
    return null;
  }

  const userPrompt = buildReasonerUserPrompt(params);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: REASONER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => {
        return "unknown error";
      });
      log.warn(`reasoner request failed: ${response.status} ${text}`);
      return null;
    }

    const data = (await response.json()) as OpenRouterResponse;
    const content = data.choices[0]?.message?.content?.trim();
    if (!content) {
      log.warn("reasoner returned empty content");
      return null;
    }

    return content;
  } catch (err) {
    log.warn("reasoner fetch failed", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
