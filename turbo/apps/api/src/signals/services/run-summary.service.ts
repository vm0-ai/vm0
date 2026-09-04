import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { agentRuns } from "@okouai/db/schema/agent-run";

import { logger } from "../../lib/log";
import { stripMarkdown } from "../../lib/strip-markdown";
import { writeDb$, type Db } from "../external/db";
import {
  FAST_PATH_MODEL,
  generateText,
  isLlmConfigured,
} from "../external/openrouter";
import { tapError } from "../utils";
import { writeRunMetadata } from "./agent-run-metadata-write.service";

const log = logger("run-summary");

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

async function generateRunSummary(
  triggerSource: string,
  prompt: string,
  resultText: string,
): Promise<string | null> {
  if (!isLlmConfigured()) {
    log.warn("OPENROUTER_API_KEY not configured, skipping text generation");
    return null;
  }

  const promptSnippet = truncateSnippet(prompt);
  const resultSnippet = truncateSnippet(resultText);

  const content = await generateText(
    FAST_PATH_MODEL,
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
    { temperature: 0.3 },
  );
  return content === null ? null : stripMarkdown(content);
}

export async function saveRunSummary(
  db: Db,
  args: {
    readonly runId: string;
    readonly triggerSource: string;
    readonly prompt: string;
    readonly resultText: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  await tapError(
    (async () => {
      const summary = await generateRunSummary(
        args.triggerSource,
        args.prompt,
        args.resultText,
      );
      signal?.throwIfAborted();

      if (!summary) {
        log.warn("Run summary generation returned null (API key missing?)", {
          runId: args.runId,
          triggerSource: args.triggerSource,
        });
        return;
      }

      await writeRunMetadata(db, {
        patch: { summary },
        where: eq(agentRuns.id, args.runId),
      });
      signal?.throwIfAborted();
    })(),
    (error) => {
      log.warn("Failed to generate run summary", {
        runId: args.runId,
        error,
      });
    },
  );
  signal?.throwIfAborted();
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
    await saveRunSummary(set(writeDb$), args, signal);
  },
);
