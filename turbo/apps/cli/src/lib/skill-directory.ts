import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED_NAMES = new Set(["node_modules", ".git", ".DS_Store"]);

/**
 * Recursively read all files from a skill directory.
 *
 * Skips hidden files (starting with .), node_modules, and .git.
 * Throws if SKILL.md is not found at the root.
 */
export function readSkillDirectory(
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
        files.push({
          path: relPath,
          content: readFileSync(join(dir, entry.name), "utf-8"),
        });
      }
    }
  }

  walk(dirPath, "");

  if (
    !files.some((f) => {
      return f.path === "SKILL.md";
    })
  ) {
    throw new Error(`SKILL.md not found in ${dirPath}`);
  }

  return files;
}
