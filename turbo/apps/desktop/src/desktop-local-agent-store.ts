import path from "node:path";
import fs from "node:fs/promises";
import type { DesktopLocalAgentEntry } from "./desktop-local-agent-types";

interface StoredLocalAgentFile {
  readonly entries: readonly DesktopLocalAgentEntry[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isDesktopLocalAgentEntry(
  value: unknown,
): value is DesktopLocalAgentEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<DesktopLocalAgentEntry>;
  return (
    isString(entry.id) &&
    isString(entry.name) &&
    isString(entry.folderPath) &&
    (entry.backend === "codex" || entry.backend === "claude-code") &&
    isString(entry.permissionMode) &&
    isString(entry.status)
  );
}

function parseStoredFile(value: unknown): StoredLocalAgentFile {
  if (typeof value !== "object" || value === null) {
    return { entries: [] };
  }
  const file = value as { readonly entries?: unknown };
  if (!Array.isArray(file.entries)) {
    return { entries: [] };
  }
  return {
    entries: file.entries.filter(isDesktopLocalAgentEntry),
  };
}

export function createDesktopLocalAgentStore(filePath: string) {
  return {
    async load(): Promise<DesktopLocalAgentEntry[]> {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        return [...parseStoredFile(JSON.parse(raw) as unknown).entries];
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
    },
    async save(entries: readonly DesktopLocalAgentEntry[]): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ entries }, null, 2)}\n`,
        "utf8",
      );
    },
  };
}
