import "server-only";
import { env } from "../../env";

const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3.1-flash-lite-preview";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Generate text using a lightweight model via OpenRouter.
 *
 * This is an internal-only service for cheap NLP tasks like title generation.
 *
 * Returns null if OPENROUTER_API_KEY is not configured.
 * Throws on HTTP errors or empty responses — callers handle errors.
 */
async function generateText(messages: ChatMessage[]): Promise<string | null> {
  const { OPENROUTER_API_KEY } = env();

  if (!OPENROUTER_API_KEY) {
    return null;
  }

  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 30,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }

  return content.trim();
}

/**
 * Generate a short title for a chat thread from conversation context.
 *
 * Accepts the user prompt and (optionally) the assistant's response so the
 * title can reflect the actual outcome rather than just the question.
 *
 * Returns null if the lightweight model is unavailable.
 */
export async function generateChatTitle(
  userMessage: string,
  assistantMessage?: string | null,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Generate a short, descriptive title (max 60 chars) for a chat conversation based on the messages below. Return only the title, no quotes or extra text.",
    },
    { role: "user", content: userMessage },
  ];
  if (assistantMessage) {
    messages.push({ role: "assistant", content: assistantMessage });
  }
  return generateText(messages);
}

/**
 * Generate a one-sentence description for a scheduled task.
 *
 * Returns null if the lightweight model is unavailable.
 */
export async function generateScheduleDescription(
  agentName: string,
  scheduleName: string,
  triggerSummary: string,
  prompt: string,
): Promise<string | null> {
  return generateText([
    {
      role: "system",
      content:
        "Write a one-sentence summary (max 120 chars) for a scheduled task. No quotes or punctuation at end. Return only the summary.",
    },
    {
      role: "user",
      content: `Agent: ${agentName}\nSchedule: ${scheduleName}\nTrigger: ${triggerSummary}\nPrompt: ${prompt.slice(0, 200)}`,
    },
  ]);
}
