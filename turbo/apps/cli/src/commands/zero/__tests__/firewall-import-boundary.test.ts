import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ZERO_COMMAND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT_SPECIFIER_PATTERN =
  /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (stats.isFile() && extname(path) === ".ts") {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => {
    return match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
  });
}

function forbiddenFirewallImport(specifier: string): boolean {
  if (specifier === "@vm0/connectors/firewalls") {
    return true;
  }
  return specifier.startsWith("@vm0/connectors/firewalls/");
}

describe("zero CLI firewall import boundary", () => {
  it("keeps zero command sources off the default eager firewall registry", () => {
    const violations = sourceFiles(ZERO_COMMAND_DIR).flatMap((file) => {
      return importSpecifiers(readFileSync(file, "utf8"))
        .filter(forbiddenFirewallImport)
        .map((specifier) => {
          return `${relative(ZERO_COMMAND_DIR, file)} -> ${specifier}`;
        });
    });

    expect(violations).toStrictEqual([]);
  });
});
