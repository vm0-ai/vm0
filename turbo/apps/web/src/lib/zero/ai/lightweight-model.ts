import "server-only";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("lightweight-model");

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
async function generateText(
  messages: ChatMessage[],
  maxTokens = 30,
): Promise<string | null> {
  const { OPENROUTER_API_KEY } = env();

  if (!OPENROUTER_API_KEY) {
    log.warn("OPENROUTER_API_KEY not configured, skipping text generation");
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
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => {
      return "unknown error";
    });
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }

  return stripMarkdown(content);
}

/**
 * Strip common markdown syntax so generated text is always plain text.
 * Handles bold/italic markers, heading prefixes, inline code, and link syntax.
 */
function stripMarkdown(text: string): string {
  return (
    text
      // Bold/italic: **text**, __text__, *text*, _text_
      .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
      // Headings: # text
      .replace(/^#{1,6}\s+/gm, "")
      // Horizontal rules: ---, ***, ___
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // Inline code: `text`
      .replace(/`([^`]+)`/g, "$1")
      // Links: [text](url)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Surrounding quotes: "title" or 'title'
      .replace(/^["'](.+)["']$/, "$1")
      .trim()
  );
}

/**
 * A single turn in the conversation history used for title generation.
 */
export interface TitleContextMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Generate a short title for a chat thread from conversation context.
 *
 * Accepts previous conversation history and the current user prompt.
 * Returns null if the lightweight model is unavailable.
 */
export async function generateChatTitle(
  currentPrompt: string,
  previousMessages?: TitleContextMessage[],
): Promise<string | null> {
  let context = "";
  if (previousMessages && previousMessages.length > 0) {
    // Include up to the last 10 messages for context, truncated to keep input small
    const recent = previousMessages.slice(-10);
    context = recent
      .map((m) => {
        return `${m.role}: ${m.content.slice(0, 200)}`;
      })
      .join("\n");
    context = `Previous conversation:\n${context}\n\n`;
  }

  return generateText([
    {
      role: "system",
      content:
        "Generate a short, descriptive title (max 60 chars) for a chat conversation. Return only the title as plain text. Do not use any markdown syntax such as #, *, **, _, ---, ``` or quotes. Just plain text.",
    },
    {
      role: "user",
      content: `${context}Current message: ${currentPrompt}`,
    },
  ]);
}

/**
 * Generate a short notification summary for a completed chat run.
 *
 * Returns null if the lightweight model is unavailable.
 */
export async function generateChatNotificationSummary(
  prompt: string,
  resultText: string,
): Promise<string | null> {
  return generateText(
    [
      {
        role: "system",
        content:
          "Summarize this AI assistant's response in one sentence (max 100 chars). Return only the summary as plain text. Do not use any markdown syntax.",
      },
      {
        role: "user",
        content: `User asked: ${prompt.slice(0, 200)}\n\nAssistant responded: ${resultText.slice(0, 500)}`,
      },
    ],
    60,
  );
}

/**
 * Truncate text to the first N lines, each capped at maxCharsPerLine.
 */
function truncateSnippet(
  text: string,
  maxLines = 3,
  maxCharsPerLine = 80,
): string {
  return text
    .split("\n")
    .slice(0, maxLines)
    .map((line) => {
      return line.length > maxCharsPerLine
        ? `${line.slice(0, maxCharsPerLine)}…`
        : line;
    })
    .join("\n");
}

/**
 * Generate a brief summary (≤50 words) for a completed run.
 *
 * Accepts the trigger source (chat, slack, email, schedule) to provide
 * context-aware summaries. Input is automatically truncated to first 3 lines
 * × 80 chars each for both prompt and result.
 *
 * Returns null if the lightweight model is unavailable.
 */
export async function generateRunSummary(
  triggerSource: string,
  prompt: string,
  resultText: string,
): Promise<string | null> {
  const promptSnippet = truncateSnippet(prompt);
  const resultSnippet = truncateSnippet(resultText);

  return generateText(
    [
      {
        role: "system",
        content: `Summarize the result of this ${triggerSource} agent run in at most 50 words as plain text. No markdown, no quotes. Focus on what was accomplished or produced — the user's original request is provided only for context.`,
      },
      {
        role: "user",
        content: `Context (user request):\n${promptSnippet}\n\nResult:\n${resultSnippet}`,
      },
    ],
    80,
  );
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
        "Write a one-sentence summary (max 120 chars) for a scheduled task as plain text — no markdown, no quotes, no special formatting. Return only the summary.",
    },
    {
      role: "user",
      content: `Agent: ${agentName}\nSchedule: ${scheduleName}\nTrigger: ${triggerSummary}\nPrompt: ${prompt.slice(0, 200)}`,
    },
  ]);
}
