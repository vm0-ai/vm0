import { generateText, isLlmConfigured } from "../external/openrouter";
import type {
  MemoryChangeItem,
  MemoryChangeSet,
} from "./memory-activity-diff.service";

const MEMORY_SUMMARY_MODEL = "google/gemini-3.1-flash-lite-preview";
const MEMORY_SUMMARY_MAX_TOKENS = 200;

function kindVerb(kind: MemoryChangeItem["kind"]): string {
  switch (kind) {
    case "learned": {
      return "Learned";
    }
    case "updated": {
      return "Updated";
    }
    case "forgotten": {
      return "Forgot";
    }
  }
}

function describeItem(item: MemoryChangeItem): string {
  const label = item.description ?? item.title ?? item.filePath;
  return `- ${kindVerb(item.kind)}: ${label} (${item.filePath})`;
}

/**
 * Narrative layer on top of the deterministic change set: a concise plain-text
 * summary of what the agent's memory learned/updated/forgot in a day.
 *
 * Returns `null` when no LLM is configured so the caller still persists the
 * deterministic items with a null summary. API errors are left to propagate;
 * the cron wraps this in `settle` to degrade on failure.
 */
export function generateMemoryDaySummary(
  changeSet: MemoryChangeSet,
): Promise<string | null> {
  if (!isLlmConfigured()) {
    return Promise.resolve(null);
  }

  const itemLines = changeSet.items.map(describeItem).join("\n");
  return generateText(
    MEMORY_SUMMARY_MODEL,
    [
      {
        role: "system",
        content:
          "You summarize how an AI agent's long-term memory about a user changed during a single day. Write one or two short, friendly plain-text sentences describing what was learned, updated, or forgotten. No markdown, no bullet points, no quotes.",
      },
      {
        role: "user",
        content: `Memory changes today:\n${itemLines}`,
      },
    ],
    MEMORY_SUMMARY_MAX_TOKENS,
  );
}
