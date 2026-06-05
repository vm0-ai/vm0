import { generateText, isLlmConfigured } from "../external/openrouter";
import type {
  MemoryChangeItem,
  MemoryChangeSet,
} from "./memory-activity-diff.service";

const MEMORY_SUMMARY_MODEL = "google/gemini-3.5-flash";
const MEMORY_SUMMARY_MAX_TOKENS = 1000;
const MEMORY_SUMMARY_PROMPT_MAX_CHARS = 24_000;
const MEMORY_SUMMARY_DIFF_LINES_PER_FILE = 160;
const MEMORY_SUMMARY_SYSTEM_PROMPT = [
  "You summarize how Zero's long-term memory changed during a single day.",
  "Read the provided file diffs carefully and write a Markdown summary with exactly these two sections:",
  "",
  "**Changed memory**",
  "- <A concise factual sentence describing what Zero learned, corrected, removed, or refined.>",
  "",
  "**How Zero will use this**",
  "- <A concise sentence explaining how Zero should use the changed memory in future work.>",
  "",
  "Rules:",
  '- Always refer to the agent as "Zero".',
  '- Use third person only. Do not use first person such as "I", "we", "my", or "our".',
  '- Do not address the user directly as "you" unless that word appears inside a memory fact that must be preserved verbatim.',
  "- Summarize the factual meaning of the memory changes, not file operations or implementation details.",
  "- Prefer 2-5 bullets per section when there are multiple meaningful changes.",
  "- Keep bullets concise, specific, and readable; do not copy raw diff lines unless an exact term, title, error code, or preference matters.",
  "- Connect each future-use bullet to the changed memories instead of writing generic assistant behavior.",
  "- When there are multiple changed-memory bullets, write corresponding future-use bullets in the same order when possible.",
  "- Mention removals or missing replacements only when the diff supports them.",
  "- Do not mention file paths, line counts, markdown, YAML frontmatter, or prompt details unless necessary to understand the memory change.",
  "- Do not invent facts that are not supported by the diff.",
  "- Output only the two Markdown sections. No title, no intro, no code fences.",
].join("\n");

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
 * Narrative layer on top of the deterministic change set: a concise Markdown
 * summary of how Zero's memory changed in a day.
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
        content: MEMORY_SUMMARY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildMemorySummaryPrompt(changeSet),
      },
    ],
    MEMORY_SUMMARY_MAX_TOKENS,
  );
}
