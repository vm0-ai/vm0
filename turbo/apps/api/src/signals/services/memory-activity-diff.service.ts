import { parseSkillFrontmatter } from "@vm0/core/skill-frontmatter";
import type {
  MemoryChangeDiff,
  MemoryChangeDiffLine,
} from "@vm0/db/schema/memory-change-item";
import { computed, type Computed } from "ccstate";

import { env } from "../../lib/env";
import { extractFilesFromTarGz } from "../../lib/tar";
import { downloadManifest, downloadS3Buffer } from "../external/s3";
import { safeSync } from "../utils";

type MemoryChangeKind = "learned" | "updated" | "forgotten";

export interface MemoryChangeItem {
  readonly kind: MemoryChangeKind;
  readonly title: string | null;
  readonly description: string | null;
  readonly filePath: string;
  readonly diff: MemoryChangeDiff;
}

export interface MemoryChangeSet {
  readonly items: readonly MemoryChangeItem[];
  readonly changed: boolean;
}

/** A file as seen in one version: its content hash and (text) content. */
interface MemoryFileState {
  readonly hash: string;
  readonly content: string;
}

export type MemoryFileMap = ReadonlyMap<string, MemoryFileState>;

const MEMORY_INDEX_PATH = "MEMORY.md";
const MAX_DIFF_LINES = 300;
const MAX_DIFF_LINE_CHARS = 500;
const MAX_LCS_CELLS = 250_000;

function splitContentLines(content: string): readonly string[] {
  return content.length === 0 ? [] : content.split("\n");
}

function truncateDiffLineText(text: string): string {
  if (text.length <= MAX_DIFF_LINE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_DIFF_LINE_CHARS)}...`;
}

function createDiffLine(
  line: Omit<MemoryChangeDiffLine, "text"> & { readonly text: string },
): MemoryChangeDiffLine {
  return {
    ...line,
    text: truncateDiffLineText(line.text),
  };
}

function lcsLengthAt(
  lengths: readonly (readonly number[])[],
  beforeIndex: number,
  afterIndex: number,
): number {
  return lengths[beforeIndex]?.[afterIndex] ?? 0;
}

function buildLcsLengths(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): readonly (readonly number[])[] {
  const lengths = Array.from({ length: beforeLines.length + 1 }, () => {
    return Array.from({ length: afterLines.length + 1 }, () => {
      return 0;
    });
  });

  for (
    let beforeIndex = beforeLines.length - 1;
    beforeIndex >= 0;
    beforeIndex--
  ) {
    const beforeLine = beforeLines[beforeIndex];
    const row = lengths[beforeIndex];
    if (beforeLine === undefined || row === undefined) {
      continue;
    }
    for (
      let afterIndex = afterLines.length - 1;
      afterIndex >= 0;
      afterIndex--
    ) {
      const afterLine = afterLines[afterIndex];
      if (afterLine === undefined) {
        continue;
      }
      if (beforeLine === afterLine) {
        row[afterIndex] =
          lcsLengthAt(lengths, beforeIndex + 1, afterIndex + 1) + 1;
      } else {
        row[afterIndex] = Math.max(
          lcsLengthAt(lengths, beforeIndex + 1, afterIndex),
          lcsLengthAt(lengths, beforeIndex, afterIndex + 1),
        );
      }
    }
  }

  return lengths;
}

function buildTwoSidedDiffLines(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): readonly MemoryChangeDiffLine[] {
  const lengths = buildLcsLengths(beforeLines, afterLines);
  const diffLines: MemoryChangeDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];
    if (
      beforeLine !== undefined &&
      afterLine !== undefined &&
      beforeLine === afterLine
    ) {
      diffLines.push(
        createDiffLine({
          op: "context",
          beforeLine: beforeIndex + 1,
          afterLine: afterIndex + 1,
          text: beforeLine,
        }),
      );
      beforeIndex++;
      afterIndex++;
    } else if (
      afterLine === undefined ||
      (beforeLine !== undefined &&
        lcsLengthAt(lengths, beforeIndex + 1, afterIndex) >=
          lcsLengthAt(lengths, beforeIndex, afterIndex + 1))
    ) {
      diffLines.push(
        createDiffLine({
          op: "remove",
          beforeLine: beforeIndex + 1,
          afterLine: null,
          text: beforeLine ?? "",
        }),
      );
      beforeIndex++;
    } else {
      diffLines.push(
        createDiffLine({
          op: "add",
          beforeLine: null,
          afterLine: afterIndex + 1,
          text: afterLine ?? "",
        }),
      );
      afterIndex++;
    }
  }

  return diffLines;
}

function firstLineNumber(
  lines: readonly MemoryChangeDiffLine[],
  side: "before" | "after",
): number | null {
  for (const line of lines) {
    const lineNumber = side === "before" ? line.beforeLine : line.afterLine;
    if (lineNumber !== null) {
      return lineNumber;
    }
  }
  return null;
}

function createDiff(
  lines: readonly MemoryChangeDiffLine[],
  stats: MemoryChangeDiff["stats"],
): MemoryChangeDiff {
  const limitedLines = lines.slice(0, MAX_DIFF_LINES);
  return {
    format: "line",
    truncated: limitedLines.length < lines.length,
    stats,
    hunks:
      limitedLines.length === 0
        ? []
        : [
            {
              beforeStartLine: firstLineNumber(limitedLines, "before"),
              afterStartLine: firstLineNumber(limitedLines, "after"),
              lines: limitedLines,
            },
          ],
  };
}

function buildOneSidedDiff(
  op: "add" | "remove",
  content: string,
): MemoryChangeDiff {
  const lines = splitContentLines(content).map((text, index) => {
    return createDiffLine({
      op,
      beforeLine: op === "remove" ? index + 1 : null,
      afterLine: op === "add" ? index + 1 : null,
      text,
    });
  });
  return createDiff(lines, {
    added: op === "add" ? lines.length : 0,
    removed: op === "remove" ? lines.length : 0,
  });
}

function buildLargeDiff(
  beforeLineCount: number,
  afterLineCount: number,
): MemoryChangeDiff {
  return {
    format: "line",
    truncated: true,
    stats: { added: afterLineCount, removed: beforeLineCount },
    hunks: [],
    omittedReason: "too_large",
  };
}

function buildLineDiff(
  beforeContent: string | null,
  afterContent: string | null,
): MemoryChangeDiff {
  if (beforeContent === null && afterContent === null) {
    return createDiff([], { added: 0, removed: 0 });
  }
  if (beforeContent === null) {
    return buildOneSidedDiff("add", afterContent ?? "");
  }
  if (afterContent === null) {
    return buildOneSidedDiff("remove", beforeContent);
  }

  const beforeLines = splitContentLines(beforeContent);
  const afterLines = splitContentLines(afterContent);
  if (beforeLines.length * afterLines.length > MAX_LCS_CELLS) {
    return buildLargeDiff(beforeLines.length, afterLines.length);
  }

  const lines = buildTwoSidedDiffLines(beforeLines, afterLines);
  const stats = lines.reduce(
    (acc, line) => {
      if (line.op === "add") {
        return { added: acc.added + 1, removed: acc.removed };
      }
      if (line.op === "remove") {
        return { added: acc.added, removed: acc.removed + 1 };
      }
      return acc;
    },
    { added: 0, removed: 0 },
  );
  return createDiff(lines, stats);
}

/**
 * Derive a human title/description for a changed file. Markdown files with
 * frontmatter (the one-fact-per-file convention) expose a `description`; for
 * everything else the title falls back to the file path.
 */
function deriveTitle(
  filePath: string,
  content: string | undefined,
): { readonly title: string | null; readonly description: string | null } {
  if (content && filePath.endsWith(".md")) {
    // Memory files are free-form, agent-written markdown, so a body that opens
    // with `---` but is not valid YAML (e.g. a `description` value starting
    // with a backtick, a reserved YAML scalar char) is expected. Guard the
    // parse and degrade to a path-based title rather than crashing the run.
    const parsed = safeSync(() => {
      return parseSkillFrontmatter(content);
    });
    if ("ok" in parsed && parsed.ok.description) {
      return {
        title: parsed.ok.name ?? filePath,
        description: parsed.ok.description,
      };
    }
  }
  return { title: filePath, description: null };
}

function classifyFile(
  filePath: string,
  before: MemoryFileState | undefined,
  after: MemoryFileState | undefined,
): MemoryChangeItem | null {
  if (after && !before) {
    const { title, description } = deriveTitle(filePath, after.content);
    return {
      kind: "learned",
      title,
      description,
      filePath,
      diff: buildLineDiff(null, after.content),
    };
  }
  if (before && !after) {
    const { title, description } = deriveTitle(filePath, before.content);
    return {
      kind: "forgotten",
      title,
      description,
      filePath,
      diff: buildLineDiff(before.content, null),
    };
  }
  if (before && after && before.hash !== after.hash) {
    const { title, description } = deriveTitle(filePath, after.content);
    return {
      kind: "updated",
      title,
      description,
      filePath,
      diff: buildLineDiff(before.content, after.content),
    };
  }
  return null;
}

/**
 * Pure deterministic change set between two memory file maps, keyed by path.
 * Classification is by manifest hash (added -> learned, removed -> forgotten,
 * hash differs -> updated); unchanged files are skipped without byte-diffing.
 *
 * `MEMORY.md` is a derived index: its churn is folded into the real fact
 * changes. It is only emitted as its own item when it changed AND no other
 * file change explains it (pure index reorg / prose-only edit).
 */
export function computeChangeSet(
  fromFiles: MemoryFileMap,
  toFiles: MemoryFileMap,
): MemoryChangeSet {
  const paths = new Set<string>([...fromFiles.keys(), ...toFiles.keys()]);

  const items: MemoryChangeItem[] = [];
  let memoryIndexItem: MemoryChangeItem | null = null;

  for (const filePath of paths) {
    const item = classifyFile(
      filePath,
      fromFiles.get(filePath),
      toFiles.get(filePath),
    );
    if (!item) {
      continue;
    }
    if (filePath === MEMORY_INDEX_PATH) {
      memoryIndexItem = item;
      continue;
    }
    items.push(item);
  }

  if (memoryIndexItem && items.length === 0) {
    items.push(memoryIndexItem);
  }

  return { items, changed: items.length > 0 };
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function loadVersionFiles(
  bucket: string,
  s3Key: string,
): Computed<Promise<MemoryFileMap>> {
  return computed(async (get): Promise<MemoryFileMap> => {
    const manifest = await get(downloadManifest(bucket, s3Key));
    const entries = manifest.files.map((file) => {
      return { path: normalizePath(file.path), hash: file.hash };
    });

    const archiveBuffer = await get(
      downloadS3Buffer(bucket, `${s3Key}/archive.tar.gz`),
    );
    const extracted = extractFilesFromTarGz(
      archiveBuffer,
      entries.map((entry) => {
        return entry.path;
      }),
    );
    const contentByPath = new Map(
      extracted.map((file) => {
        return [file.path, file.content];
      }),
    );

    const fileMap = new Map<string, MemoryFileState>();
    for (const entry of entries) {
      fileMap.set(entry.path, {
        hash: entry.hash,
        content: contentByPath.get(entry.path) ?? "",
      });
    }
    return fileMap;
  });
}

/**
 * Load both memory versions from S3 and compute their net change set. Reads the
 * per-file hash from each version's manifest and the file bodies from its
 * archive, then delegates to the pure `computeChangeSet`.
 *
 * A null `fromS3Key` means there was no baseline version (the user's memory
 * first appeared in the window), so the from-side is empty and every file in
 * `toS3Key` is classified as `learned`.
 */
export function computeMemoryChangeSet(
  fromS3Key: string | null,
  toS3Key: string,
): Computed<Promise<MemoryChangeSet>> {
  return computed(async (get): Promise<MemoryChangeSet> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const [fromFiles, toFiles] = await Promise.all([
      fromS3Key === null
        ? Promise.resolve<MemoryFileMap>(new Map())
        : get(loadVersionFiles(bucket, fromS3Key)),
      get(loadVersionFiles(bucket, toS3Key)),
    ]);
    return computeChangeSet(fromFiles, toFiles);
  });
}
