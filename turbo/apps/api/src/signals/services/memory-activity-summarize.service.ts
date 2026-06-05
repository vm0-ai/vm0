import { generateText, isLlmConfigured } from "../external/openrouter";
import type {
  MemoryChangeItem,
  MemoryChangeSet,
} from "./memory-activity-diff.service";

const MEMORY_SUMMARY_MODEL = "google/gemini-3.5-flash";
const MEMORY_SUMMARY_MAX_TOKENS = 1000;
const MEMORY_SUMMARY_PROMPT_MAX_CHARS = 24_000;
const MEMORY_SUMMARY_DIFF_LINES_PER_FILE = 160;
export const MEMORY_SUMMARY_SYSTEM_PROMPT = [
  "You summarize how Zero's long-term memory changed during a single day.",
  "Read the provided internal memory diffs carefully and write a Markdown summary with exactly these two sections:",
  "",
  "**Changed memory**",
  "- <A concise factual sentence with Zero as the subject, describing what Zero learned, remembered, corrected, forgot, no longer believes, no longer assumes, or refined.>",
  "",
  "**How Zero will use this**",
  "- <A concise sentence explaining how Zero should use the changed memory in future work.>",
  "",
  "Rules:",
  '- Always refer to the agent as "Zero".',
  '- Use third person only. Do not use first person such as "I", "we", "my", or "our".',
  '- Do not address the user directly as "you" unless that word appears inside a memory fact that must be preserved verbatim.',
  '- Phrase natural memory changes in third person with "Zero" as the subject, such as "Zero learned...", "Zero remembered...", "Zero forgot...", or "Zero no longer assumes...".',
  '- Never phrase a memory update as if Zero is speaking, such as "I learned...", "I remember...", or "I forgot...".',
  "- Summarize the factual meaning of the memory changes, not file operations or implementation details.",
  "- Never say or imply that Zero modified, deleted, created, consulted, or will no longer consult memory files, indexes, references, profiles, storage artifacts, YAML frontmatter, Markdown files, or line counts.",
  "- For deletions, describe the factual memory Zero forgot or no longer treats as known; do not describe deleted files, removed references, or missing storage.",
  "- Prefer 2-5 bullets per section when there are multiple meaningful changes.",
  "- Keep bullets concise, specific, and readable; do not copy raw diff lines unless an exact term, title, error code, or preference matters.",
  "- Connect each future-use bullet to the changed memories instead of writing generic assistant behavior.",
  "- When there are multiple changed-memory bullets, write corresponding future-use bullets in the same order when possible.",
  "- Mention forgotten facts, invalidated facts, or missing replacements only when the diff supports them.",
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
    return [`Raw memory text diff omitted: ${item.diff.omittedReason}.`];
  }

  const lines = item.diff.hunks.flatMap((hunk) => {
    return hunk.lines;
  });
  if (lines.length === 0) {
    return ["Raw memory text diff: (no line-level changes captured)"];
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
  return ["Raw memory text diff:", ...rendered];
}

function itemBlock(item: MemoryChangeItem): readonly string[] {
  return [
    `Internal source path (do not mention): ${item.filePath}`,
    `Internal storage operation (do not mention): ${changeLabel(item)}`,
    `Internal line counts (do not mention): +${item.diff.stats.added} -${item.diff.stats.removed}`,
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
  const lines = [
    "Internal memory diffs today. Interpret these as memory changes, but do not echo internal source labels or storage operations:",
  ];
  if (changeSet.items.length === 0) {
    lines.push("", "No changed memory content.");
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
        "[raw memory text diff truncated because the prompt budget was reached]",
      );
      break;
    }
    completedFiles++;
  }

  if (budgetReached) {
    const omittedFiles = changeSet.items.length - completedFiles;
    appendLineWithinBudget(
      lines,
      `[${omittedFiles} internal memory sources omitted because the prompt budget was reached]`,
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
