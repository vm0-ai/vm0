import { generateText, isLlmConfigured } from "../external/openrouter";
import type {
  MemoryChangeItem,
  MemoryChangeSet,
} from "./memory-activity-diff.service";

const MEMORY_SUMMARY_MODEL = "google/gemini-3.5-flash";
const MEMORY_SUMMARY_MAX_TOKENS = 1000;
const MEMORY_SUMMARY_PROMPT_MAX_CHARS = 24_000;
const MEMORY_SUMMARY_DIFF_LINES_PER_FILE = 160;

function changeLabel(item: MemoryChangeItem): string {
  if (!item.diff.beforeExists && item.diff.afterExists) {
    return "added";
  }
  if (item.diff.beforeExists && !item.diff.afterExists) {
    return "deleted";
  }
  if (item.diff.beforeExists && item.diff.afterExists) {
    return "modified";
  }
  return "unchanged";
}

function linePrefix(op: "context" | "add" | "remove"): string {
  if (op === "add") {
    return "+";
  }
  if (op === "remove") {
    return "-";
  }
  return " ";
}

function diffLines(item: MemoryChangeItem): readonly string[] {
  if (item.diff.omittedReason) {
    return [`Diff omitted: ${item.diff.omittedReason}.`];
  }

  const lines = item.diff.hunks.flatMap((hunk) => {
    return hunk.lines;
  });
  if (lines.length === 0) {
    return ["Diff: (no line-level changes captured)"];
  }

  const rendered = lines
    .slice(0, MEMORY_SUMMARY_DIFF_LINES_PER_FILE)
    .map((line) => {
      return `${linePrefix(line.op)} ${line.text}`;
    });
  const omittedLineCount = lines.length - rendered.length;
  if (omittedLineCount > 0 || item.diff.truncated) {
    rendered.push(
      `[diff truncated: ${omittedLineCount} captured lines omitted; additional source lines may also be omitted]`,
    );
  }
  return ["Diff:", ...rendered];
}

function itemBlock(item: MemoryChangeItem): readonly string[] {
  return [
    `File: ${item.filePath}`,
    `Change: ${changeLabel(item)}`,
    `Lines: +${item.diff.stats.added} -${item.diff.stats.removed}`,
    ...diffLines(item),
  ];
}

function appendLineWithinBudget(lines: string[], line: string): boolean {
  const next = [...lines, line].join("\n");
  if (next.length > MEMORY_SUMMARY_PROMPT_MAX_CHARS) {
    return false;
  }
  lines.push(line);
  return true;
}

export function buildMemorySummaryPrompt(changeSet: MemoryChangeSet): string {
  const lines = ["Memory file diffs today:"];
  if (changeSet.items.length === 0) {
    lines.push("", "No changed memory files.");
    return lines.join("\n");
  }

  let completedFiles = 0;
  let budgetReached = false;
  for (const item of changeSet.items) {
    if (!appendLineWithinBudget(lines, "")) {
      budgetReached = true;
      break;
    }

    let completedBlock = true;
    for (const line of itemBlock(item)) {
      if (!appendLineWithinBudget(lines, line)) {
        completedBlock = false;
        budgetReached = true;
        break;
      }
    }

    if (!completedBlock) {
      appendLineWithinBudget(
        lines,
        "[diff truncated because the prompt budget was reached]",
      );
      break;
    }
    completedFiles++;
  }

  if (budgetReached) {
    const omittedFiles = changeSet.items.length - completedFiles;
    appendLineWithinBudget(
      lines,
      `[${omittedFiles} changed memory files omitted because the prompt budget was reached]`,
    );
  }

  return lines.join("\n");
}

/**
 * Narrative layer on top of the deterministic change set: a concise plain-text
 * summary of how the agent's memory changed in a day.
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

  return generateText(
    MEMORY_SUMMARY_MODEL,
    [
      {
        role: "system",
        content:
          "You summarize how an AI agent's long-term memory files changed during a single day. Read the provided file diffs carefully. Write one or two natural plain-text sentences that summarize the meaningful memory changes for the user. Focus on facts that were added, removed, or corrected. Do not mention file paths, line counts, markdown, YAML frontmatter, or implementation details unless they are necessary to understand the memory change. Do not invent facts that are not supported by the diff. No markdown, no bullet points, no quotes.",
      },
      {
        role: "user",
        content: buildMemorySummaryPrompt(changeSet),
      },
    ],
    MEMORY_SUMMARY_MAX_TOKENS,
  );
}
