import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { logger } from "../../lib/log";
import { optionalEnv } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { safeAsync } from "../utils";

const log = logger("run-summary");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "google/gemini-3.1-flash-lite-preview";

interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenRouterResponse {
  readonly choices: readonly {
    readonly message: {
      readonly content: string;
    };
  }[];
}

async function generateText(
  messages: readonly ChatMessage[],
  maxTokens: number,
): Promise<string | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    log.warn("OPENROUTER_API_KEY not configured, skipping text generation");
    return null;
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
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
  const content = data.choices[0]?.message.content.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }
  return stripMarkdown(content);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
}

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
        ? `${line.slice(0, maxCharsPerLine)}...`
        : line;
    })
    .join("\n");
}

function generateRunSummary(
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
        content: `Summarize the result of this ${triggerSource} agent run in at most 50 words as plain text. No markdown, no quotes. Focus on what was accomplished or produced - the user's original request is provided only for context.`,
      },
      {
        role: "user",
        content: `Context (user request):\n${promptSnippet}\n\nResult:\n${resultSnippet}`,
      },
    ],
    80,
  );
}

export const saveRunSummary$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly triggerSource: string;
      readonly prompt: string;
      readonly resultText: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await safeAsync(async () => {
      const summary = await generateRunSummary(
        args.triggerSource,
        args.prompt,
        args.resultText,
      );
      signal.throwIfAborted();

      if (!summary) {
        log.warn("Run summary generation returned null (API key missing?)", {
          runId: args.runId,
          triggerSource: args.triggerSource,
        });
        return;
      }

      const writeDb = set(writeDb$);
      await writeDb
        .update(zeroRuns)
        .set({ summary })
        .where(eq(zeroRuns.id, args.runId));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();

    if ("error" in result) {
      log.warn("Failed to generate run summary", {
        runId: args.runId,
        error: result.error,
      });
    }
  },
);
