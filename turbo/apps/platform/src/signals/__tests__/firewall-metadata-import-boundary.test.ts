import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PLATFORM_SRC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SERVER_FIREWALL_METADATA_SPECIFIER =
  "@vm0/connectors/firewall-metadata/server";
const IMPORT_SPECIFIER_PATTERN =
  /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function isSkippedDirectory(name: string): boolean {
  return name === "__tests__" || name === "mocks" || name === "test";
}

function listProductionSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(entry.name)) {
        files.push(...listProductionSourceFiles(entryPath));
      }
      continue;
    }
    if (
      entry.isFile() &&
      !entry.name.endsWith(".d.ts") &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function importSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => {
    return match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
  });
}

function importsSpecifier(source: string, specifier: string): boolean {
  return importSpecifiers(source).some((importedSpecifier) => {
    return (
      importedSpecifier === specifier ||
      importedSpecifier.startsWith(`${specifier}/`)
    );
  });
}

describe("firewall metadata import boundary", () => {
  it("keeps server-only firewall metadata out of platform production source", () => {
    const offenders = listProductionSourceFiles(PLATFORM_SRC_DIR).filter(
      (file) => {
        return importsSpecifier(
          readFileSync(file, "utf8"),
          SERVER_FIREWALL_METADATA_SPECIFIER,
        );
      },
    );

    expect(
      offenders.map((file) => {
        return relative(PLATFORM_SRC_DIR, file);
      }),
    ).toStrictEqual([]);
  });
});
