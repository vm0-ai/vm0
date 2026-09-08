import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a generated manifest, or under `--check` asserts that the committed
 * copy already matches.
 *
 * The manifests are committed so the catalogue type-checks and tests without a
 * generate step, and `--check` runs in `pnpm lint` so a stylesheet or component
 * change that nobody regenerated fails CI instead of quietly aging.
 */
export function emit(outFile, manifest, summary) {
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    assert.equal(
      readFileSync(outFile, "utf8"),
      json,
      `${outFile} is stale; run pnpm -F @okouai/design-system generate`,
    );
    process.stdout.write(`up to date — ${summary}\n`);
    return;
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json);
  process.stdout.write(`${summary}\n`);
}
