import { parseSkillFrontmatter } from "@vm0/core/skill-frontmatter";
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
  readonly beforeSnippet: string | null;
  readonly afterSnippet: string | null;
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

function snippetOf(content: string | undefined): string | null {
  return content === undefined ? null : truncateSnippet(content);
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
      beforeSnippet: null,
      afterSnippet: snippetOf(after.content),
    };
  }
  if (before && !after) {
    const { title, description } = deriveTitle(filePath, before.content);
    return {
      kind: "forgotten",
      title,
      description,
      filePath,
      beforeSnippet: snippetOf(before.content),
      afterSnippet: null,
    };
  }
  if (before && after && before.hash !== after.hash) {
    const { title, description } = deriveTitle(filePath, after.content);
    return {
      kind: "updated",
      title,
      description,
      filePath,
      beforeSnippet: snippetOf(before.content),
      afterSnippet: snippetOf(after.content),
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
