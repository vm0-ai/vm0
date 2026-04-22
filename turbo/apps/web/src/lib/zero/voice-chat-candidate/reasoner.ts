import "server-only";
import { env } from "../../../env";
import { logger } from "../../shared/logger";
import {
  CONVERSATION_SECTION,
  REASONER_SYSTEM_PROMPT,
  buildReasonerUserPrompt,
} from "./reasoner-prompts";

const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-sonnet-4.5";
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 800;
const TEMPERATURE = 0.2;

const log = logger("zero:voice-chat-candidate:reasoner");

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface ItemForReasoner {
  seq: number;
  role: string;
  content: string | null;
  createdAt: string;
}

interface TaskForReasoner {
  id: string;
  status: string;
  prompt: string;
  resultText: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface CallReasonerParams {
  agentSystemPrompt: string;
  priorConversationSummary: string | null;
  transcript: ItemForReasoner[];
  tasks: TaskForReasoner[];
}

interface ReasonerResult {
  conversationSummary: string;
}

export async function callReasoner(
  params: CallReasonerParams,
): Promise<ReasonerResult | null> {
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

  let response: Response;
  try {
    response = await fetch(BASE_URL, {
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
  } catch (err) {
    // Narrow catch: only the two runtime conditions that fetch itself can
    // produce and that we explicitly want to recover from — AbortError from
    // our 30s timeout and TypeError from network failures. Anything else
    // (programmer bugs, unexpected runtime errors) must fail fast.
    if (err instanceof DOMException && err.name === "AbortError") {
      log.warn("reasoner fetch aborted (timeout)");
      return null;
    }
    if (err instanceof TypeError) {
      log.warn("reasoner network error", err);
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    log.warn(`reasoner request failed: ${response.status} ${text}`);
    return null;
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message?.content?.trim();
  if (!content) {
    log.warn("reasoner returned empty content");
    return null;
  }

  return parseReasonerSections(content);
}

function parseReasonerSections(raw: string): ReasonerResult {
  return {
    conversationSummary: extractSection(raw, CONVERSATION_SECTION),
  };
}

function extractSection(raw: string, name: string): string {
  const marker = `---${name}---`;
  const idx = raw.indexOf(marker);
  if (idx === -1) return "";
  const after = raw.slice(idx + marker.length);
  const nextIdx = after.search(/---[A-Z]+---/u);
  const slice = nextIdx === -1 ? after : after.slice(0, nextIdx);
  return slice.trim();
}
