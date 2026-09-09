import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectLegacyClassUsages } from "./style-class-usage.mjs";

const root = resolve(import.meta.dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function nonempty(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert(value.trim(), `${label} must not be empty`);
}

export function validateMigration(manifest, baseline, cases) {
  assert.equal(manifest.version, 1, "Unsupported migration manifest version");
  assert.equal(cases.version, 1, "Unsupported visual case version");
  nonempty(manifest.owner, "Migration owner");
  const tokens = new Set();
  const families = new Set();
  for (const family of manifest.families) {
    nonempty(family.id, "Family id");
    assert(!families.has(family.id), `Duplicate family ${family.id}`);
    families.add(family.id);
    nonempty(family.owner, `${family.id} owner`);
    nonempty(family.replacement, `${family.id} replacement`);
    assert(Number.isInteger(family.phase) && family.phase > 0);
    for (const token of family.tokens) {
      nonempty(token, "Legacy token");
      assert(!tokens.has(token), `Duplicate migration token ${token}`);
      tokens.add(token);
    }
  }
  for (const token of baseline.legacyClassTokens) {
    assert(tokens.has(token), `Unmapped legacy token ${token}`);
  }
  const caseIds = new Set();
  for (const item of cases.cases) {
    assert(/^[a-z0-9-]+$/.test(item.id), "Case id must be a safe filename");
    assert(!caseIds.has(item.id), `Duplicate case ${item.id}`);
    caseIds.add(item.id);
    assert(item.path.startsWith("/") && !item.path.startsWith("//"));
    assert(["light", "dark"].includes(item.theme));
    assert(item.viewport.width > 0 && item.viewport.height > 0);
    assert(item.deviceScaleFactor > 0);
  }
  const batches = new Set();
  for (const batch of manifest.batches) {
    assert(!batches.has(batch.id), `Duplicate batch ${batch.id}`);
    batches.add(batch.id);
    assert(families.has(batch.family), `Unknown family ${batch.family}`);
    assert(batch.consumers.length > 0 && batch.cases.length > 0);
    for (const token of batch.tokens) {
      assert(tokens.has(token), `Unknown batch token ${token}`);
    }
    for (const id of batch.cases) {
      assert(caseIds.has(id), `Missing visual case ${id}`);
    }
    assert(
      [
        "planned",
        "baselined",
        "implemented",
        "verified",
        "merged",
        "blocked",
      ].includes(batch.status),
      `Invalid status for ${batch.id}`,
    );
    if (["baselined", "verified", "merged"].includes(batch.status)) {
      assert(batch.evidence.length > 0, `${batch.id} needs durable evidence`);
    }
    for (const evidence of batch.evidence) {
      assert(/^https:\/\//.test(evidence.url), "Evidence needs an HTTPS URL");
      assert(/^[a-f0-9]{64}$/.test(evidence.sha256), "Evidence needs SHA-256");
      assert(
        /^[a-f0-9]{40}$/.test(evidence.commit),
        "Evidence needs a full commit",
      );
    }
  }
}

function total(records) {
  return Object.values(records).reduce((sum, values) => sum + values.length, 0);
}

function inventory(manifest, baseline, baselineText) {
  const files = globSync(
    [
      "apps/platform/src/**/*.ts",
      "apps/platform/src/**/*.tsx",
      "packages/ui/src/**/*.ts",
      "packages/ui/src/**/*.tsx",
      "../e2e/playwright/**/*.ts",
    ],
    { cwd: root, exclude: ["**/node_modules/**"] },
  ).sort();
  // Unlike the legacy policy, this report includes tests and deployed E2E hooks.
  // It is an inventory, not permission to use any of these classes.
  const usages = collectLegacyClassUsages(
    root,
    files,
    baseline.legacyClassTokens,
  );
  return {
    version: 1,
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    baselineSha256: createHash("sha256").update(baselineText).digest("hex"),
    counts: {
      legacyTokens: baseline.legacyClassTokens.length,
      cssDeclarations: total(baseline.cssAtoms),
      productionUsages: Object.values(baseline.classUsages).reduce(
        (sum, values) =>
          sum +
          Object.values(values).reduce((count, value) => count + value, 0),
        0,
      ),
      styleInjections: total(baseline.styleInjections),
    },
    families: manifest.families.map((family) => ({
      ...family,
      consumers: Object.entries(usages).flatMap(([file, counts]) =>
        Object.entries(counts)
          .filter(([token]) => family.tokens.includes(token))
          .map(([token, count]) => ({ file, token, count })),
      ),
    })),
    cssDeclarations: baseline.cssAtoms,
    styleInjections: baseline.styleInjections,
    batches: manifest.batches,
    limitations: [
      "File-level references resolve class constants; they are not a complete runtime reachability proof.",
      "Pure attribute/type selectors, component inline properties, and exact third-party consumer ownership still need the enforcement follow-up in #32402.",
      "A planned batch and green inventory check do not establish visual acceptance.",
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = readJson(resolve(root, "style-migration-manifest.json"));
    const baselineText = readFileSync(
      resolve(root, "style-legacy-baseline.json"),
      "utf8",
    );
    const baseline = JSON.parse(baselineText);
    const cases = readJson(resolve(root, manifest.caseFile));
    validateMigration(manifest, baseline, cases);
    for (const batch of manifest.batches) {
      for (const file of batch.consumers) readFileSync(resolve(root, file));
    }
    if (process.argv.includes("--json")) {
      console.log(
        JSON.stringify(inventory(manifest, baseline, baselineText), null, 2),
      );
    } else {
      console.log(
        "Style migration manifest passed; this does not certify visual acceptance.",
      );
    }
  } catch (error) {
    console.error(
      `Style migration check failed: ${error.message}. Read docs/style-migration.md.`,
    );
    process.exitCode = 1;
  }
}
