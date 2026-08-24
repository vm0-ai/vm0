#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const turboDir = path.resolve(scriptDir, "../../..");
const repositoryRoot = path.resolve(turboDir, "..");

const scanRoots = [
  "turbo/apps/api/src",
  "turbo/apps/api/scripts",
  "turbo/packages/api-contracts/src",
  "turbo/packages/core/src",
  "turbo/packages/db/src/jsonb-contracts",
  "turbo/packages/db/src/schema",
];

const forbiddenPaths = [
  "turbo/apps/api/src/signals/services/agent-compose-content.ts",
  "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts",
  "turbo/apps/api/src/signals/services/compose-data.service.ts",
  "turbo/apps/api/src/test-fixtures/agent-compose-provenance.ts",
  "turbo/apps/api/src/test-fixtures/historical-agent-composes.ts",
  "turbo/packages/api-contracts/src/contracts/composes.ts",
  "turbo/packages/db/src/jsonb-contracts/agent-compose.ts",
  "turbo/packages/db/src/schema/agent-compose.ts",
  "turbo/packages/db/src/schema/zero-agent.ts",
  "turbo/packages/db/scripts/agent-compose-consolidation-preflight.ts",
  "turbo/packages/db/scripts/agent-compose-consolidation-preflight-manifest.ts",
  "turbo/packages/db/scripts/agent-compose-consolidation-preflight-refinements.ts",
  "turbo/packages/db/scripts/agent-run-launch-snapshot-backfill.ts",
  "turbo/packages/db/scripts/test-agent-compose-consolidation-preflight.ts",
  "turbo/packages/db/scripts/test-agent-run-launch-snapshot-backfill.ts",
  "turbo/packages/db/scripts/test-agent-schema-absence-runtime-seal.ts",
  "turbo/packages/db/scripts/test-canonical-agent-data-plane.ts",
  "turbo/packages/db/scripts/test-canonical-agent-write-plane.ts",
  "turbo/packages/db/scripts/test-checkpoint-agent-compose-snapshot-nullable.ts",
  "turbo/packages/db/scripts/test-zero-runs-stage-6.ts",
];

const forbiddenFragments = [
  "agent_composes",
  "agent_compose_versions",
  "zero_agents",
  "agent_compose_id",
  "agent_compose_version_id",
  "agent_compose_snapshot",
  "default_compose_id",
  "selected_compose_id",
  "agentComposes",
  "agentComposeVersions",
  "zeroAgents",
  "agentComposeId",
  "agentComposeVersionId",
  "agentComposeSnapshot",
  "defaultComposeId",
  "selectedComposeId",
  "AgentCompose",
  "agent-compose",
  "contracts/composes",
  "schema/zero-agent",
];

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute)));
      continue;
    }
    if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function isActiveSource(relative) {
  return !(
    relative === "turbo/apps/api/scripts/check-final-agent-schema.mjs" ||
    relative.includes("/__tests__/") ||
    relative.includes("/__benches__/") ||
    relative.includes("/test-fixtures/") ||
    relative.includes("/migrations/") ||
    relative.includes("/scripts/migrations/") ||
    relative.includes("/src/signals/routes/test-") ||
    /\.(?:bench|spec|suite|test)\.[cm]?[jt]sx?$/u.test(relative)
  );
}

const files = [];
for (const root of scanRoots) {
  files.push(...(await collectFiles(path.join(repositoryRoot, root))));
}

const violations = [];
for (const absolute of files.sort()) {
  const relative = path.relative(repositoryRoot, absolute);
  if (!isActiveSource(relative)) {
    continue;
  }
  const source = await fs.readFile(absolute, "utf8");
  const lines = source.split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    for (const fragment of forbiddenFragments) {
      if (line.includes(fragment)) {
        violations.push({
          fragment,
          line: lineIndex + 1,
          path: relative,
        });
      }
    }
  }
}

for (const relative of forbiddenPaths) {
  try {
    await fs.access(path.join(repositoryRoot, relative));
    violations.push({
      fragment: "retired transition file",
      line: 1,
      path: relative,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations.slice(0, 100)) {
    process.stderr.write(
      `${violation.path}:${violation.line}: retired Agent persistence token ${JSON.stringify(violation.fragment)}\n`,
    );
  }
  if (violations.length > 100) {
    process.stderr.write(
      `... and ${violations.length - 100} more violations\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Final Agent schema validator passed across ${files.length} source files.\n`,
  );
}
