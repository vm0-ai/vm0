import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

function workspace(t) {
  const root = mkdtempSync(resolve(tmpdir(), "style-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "scripts"));
  for (const file of ["style-migration.mjs", "style-class-usage.mjs"]) {
    copyFileSync(
      resolve(import.meta.dirname, file),
      resolve(root, "scripts", file),
    );
  }
  symlinkSync(
    resolve(import.meta.dirname, "../node_modules"),
    resolve(root, "node_modules"),
    "dir",
  );
  const manifest = {
    version: 1,
    owner: "test-owner",
    caseFile: "cases.json",
    families: [
      {
        id: "controls",
        owner: "test-owner",
        replacement: "Shared tokens",
        phase: 1,
        tokens: ["legacy"],
      },
    ],
    batches: [
      {
        id: "one",
        family: "controls",
        tokens: ["legacy"],
        consumers: ["view.tsx"],
        cases: ["light"],
        status: "planned",
        evidence: [],
      },
    ],
  };
  writeFileSync(
    resolve(root, "view.tsx"),
    'export const View = () => <div className="legacy" />;',
  );
  writeFileSync(
    resolve(root, "style-migration-manifest.json"),
    JSON.stringify(manifest),
  );
  writeFileSync(
    resolve(root, "style-legacy-baseline.json"),
    JSON.stringify({ legacyClassTokens: ["legacy"] }),
  );
  writeFileSync(
    resolve(root, "cases.json"),
    JSON.stringify({
      version: 1,
      cases: [
        {
          id: "light",
          path: "/agents",
          theme: "light",
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
        },
      ],
    }),
  );
  return { root, manifest };
}

function check(root) {
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts/style-migration.mjs")],
    { encoding: "utf8" },
  );
}

test("the command rejects newly unmapped debt and reports an actionable failure", (t) => {
  const { root } = workspace(t);
  assert.equal(check(root).status, 0);
  writeFileSync(
    resolve(root, "style-legacy-baseline.json"),
    JSON.stringify({ legacyClassTokens: ["legacy", "untracked"] }),
  );
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unmapped legacy token untracked/);
  assert.match(result.stderr, /docs\/style-migration.md/);
});

test("the command rejects missing replay coverage and missing consumer files", (t) => {
  const { root, manifest } = workspace(t);
  manifest.batches[0].cases = ["missing"];
  writeFileSync(
    resolve(root, "style-migration-manifest.json"),
    JSON.stringify(manifest),
  );
  assert.match(check(root).stderr, /Missing visual case missing/);
  manifest.batches[0].cases = ["light"];
  writeFileSync(
    resolve(root, "style-migration-manifest.json"),
    JSON.stringify(manifest),
  );
  rmSync(resolve(root, "view.tsx"));
  assert.equal(check(root).status, 1);
});

test("an acceptance state requires a durable commit-bound evidence record", (t) => {
  const { root, manifest } = workspace(t);
  manifest.batches[0].status = "verified";
  writeFileSync(
    resolve(root, "style-migration-manifest.json"),
    JSON.stringify(manifest),
  );
  assert.match(check(root).stderr, /needs durable evidence/);
  assert.equal(
    JSON.parse(readFileSync(resolve(root, "style-migration-manifest.json")))
      .batches[0].status,
    "verified",
  );
});
