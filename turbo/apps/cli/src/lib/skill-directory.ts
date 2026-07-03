import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED_NAMES = new Set(["node_modules", ".git", ".DS_Store"]);

/**
 * Recursively read all supplementary files from a directory.
 *
 * Skips hidden files (starting with .), node_modules, and .git.
 * Rejects SKILL.md: it is synthesized server-side from the workflow's
 * (name, description, instruction) and must not be uploaded.
 */
export function readSupplementaryFiles(
  dirPath: string,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  function walk(dir: string, prefix: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_NAMES.has(entry.name)) continue;

      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
      } else {
        if (relPath === "SKILL.md") {
          throw new Error(
            "SKILL.md is reserved and generated automatically; remove it from the directory",
          );
        }
        files.push({
          path: relPath,
          content: readFileSync(join(dir, entry.name), "utf-8"),
        });
      }
    }
  }

  walk(dirPath, "");

  return files;
}
