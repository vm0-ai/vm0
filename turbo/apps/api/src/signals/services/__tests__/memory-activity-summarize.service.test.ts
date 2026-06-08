import { describe, expect, it } from "vitest";

import type { MemoryChangeItem } from "../memory-activity-diff.service";
import {
  buildMemorySummaryPrompt,
  MEMORY_SUMMARY_SYSTEM_PROMPT,
} from "../memory-activity-summarize.service";

function addedItem(
  filePath: string,
  lines: readonly string[],
): MemoryChangeItem {
  return {
    filePath,
    diff: {
      format: "line",
      beforeExists: false,
      afterExists: true,
      truncated: false,
      stats: { added: lines.length, removed: 0 },
      hunks: [
        {
          beforeStartLine: null,
          afterStartLine: 1,
          lines: lines.map((text, index) => {
            return {
              op: "add",
              beforeLine: null,
              afterLine: index + 1,
              text,
            };
          }),
        },
      ],
    },
  };
}

describe("buildMemorySummaryPrompt", () => {
  it("instructs the model to describe user-facing memory changes instead of storage operations", () => {
    expect(MEMORY_SUMMARY_SYSTEM_PROMPT).toContain(
      'Phrase natural memory changes in third person with "Zero" as the subject',
    );
    expect(MEMORY_SUMMARY_SYSTEM_PROMPT).toContain(
      '"Zero learned...", "Zero remembered...", "Zero forgot...", or "Zero no longer assumes..."',
    );
    expect(MEMORY_SUMMARY_SYSTEM_PROMPT).toContain(
      "Never phrase a memory update as if Zero is speaking",
    );
    expect(MEMORY_SUMMARY_SYSTEM_PROMPT).toContain(
      "Never say or imply that Zero modified, deleted, created, consulted, or will no longer consult memory files",
    );
    expect(MEMORY_SUMMARY_SYSTEM_PROMPT).toContain(
      "do not describe deleted files, removed references, or missing storage",
    );
  });

  it("limits rendered diff lines per changed file", () => {
    const lines = Array.from({ length: 170 }, (_, index) => {
      return `line-${index}`;
    });

    const prompt = buildMemorySummaryPrompt({
      changed: true,
      items: [addedItem("facts/large.md", lines)],
    });

    expect(prompt).toContain("+ line-159");
    expect(prompt).not.toContain("+ line-160");
    expect(prompt).toContain(
      "[diff truncated: 10 captured lines omitted; additional source lines may also be omitted]",
    );
  });

  it("omits later files when the prompt budget is reached", () => {
    const items = Array.from({ length: 40 }, (_, index) => {
      return addedItem(`facts/${String(index).padStart(2, "0")}.md`, [
        `preference ${index}: ${"detail ".repeat(260)}`,
      ]);
    });

    const prompt = buildMemorySummaryPrompt({ changed: true, items });

    expect(prompt.length).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain(
      "Internal source path (do not mention): facts/00.md",
    );
    expect(prompt).not.toContain(
      "Internal source path (do not mention): facts/39.md",
    );
    expect(prompt).toContain("prompt budget was reached");
  });
});
