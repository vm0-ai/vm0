import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The bootstrap entry must stay trivially safe to load so the auto-updater
// survives main-bundle load failures (see src/bootstrap.ts). This test walks
// the static value-import graph from bootstrap.ts and rejects any module
// outside the allowlist below — most importantly anything under `@vm0/*`.
// scripts/check-bootstrap-bundle.mjs re-checks the built bundle.

const ALLOWED_PACKAGES = new Set([
  "electron",
  "update-electron-app",
  "@sentry/electron/main",
]);

// "./main.js" is the runtime require of the main bundle, intentionally
// external to the bootstrap bundle.
const IGNORED_SPECIFIERS = new Set(["./main.js"]);

const IMPORT_PATTERN =
  /(?:^|\n)import\s+(?<type>type\s+)?(?:[^"']*?|[^"']*?\{[^}]*\}[^"']*?)from\s+["'](?<from>[^"']+)["']|await import\(["'](?<dynamic>[^"']+)["']\)/g;

function valueImports(sourceFile: string): readonly string[] {
  const source = readFileSync(join(__dirname, sourceFile), "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const groups = match.groups ?? {};
    if (groups.type) {
      continue;
    }
    const specifier = groups.from ?? groups.dynamic;
    if (specifier && !IGNORED_SPECIFIERS.has(specifier)) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("bootstrap import graph", () => {
  it("never reaches a workspace or unexpected package import", () => {
    const visited = new Set<string>();
    const queue = ["bootstrap.ts"];
    const violations: string[] = [];

    while (queue.length > 0) {
      const sourceFile = queue.pop();
      if (!sourceFile || visited.has(sourceFile)) {
        continue;
      }
      visited.add(sourceFile);

      for (const specifier of valueImports(sourceFile)) {
        if (specifier.startsWith("node:")) {
          continue;
        }
        if (!specifier.startsWith(".")) {
          if (!ALLOWED_PACKAGES.has(specifier)) {
            violations.push(`${sourceFile} imports ${specifier}`);
          }
          continue;
        }
        if (specifier.endsWith(".json")) {
          continue;
        }
        queue.push(`${specifier.replace(/^\.\//, "")}.ts`);
      }
    }

    expect(violations).toEqual([]);
    // Keep the reachable set intentional: growing it means growing the code
    // that must never fail to load.
    expect([...visited].sort()).toEqual([
      "bootstrap-degraded.ts",
      "bootstrap.ts",
      "computer-use-types.ts",
      "config.ts",
      "desktop-api-base-url.ts",
      "desktop-auto-update-policy.ts",
      "desktop-auto-updates.ts",
      "desktop-update-feed.ts",
    ]);
  });
});
