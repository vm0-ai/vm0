#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  buildZeroAgentComposeContent,
  computeComposeVersionId,
} from "../../../apps/api/src/signals/services/agent-compose-content";
import {
  CATALOG_DEPENDENCY_KINDS,
  CATALOG_DEPENDENCY_QUERY,
  EXPECTED_CATALOG_DEPENDENCIES,
  EXPECTED_REPOSITORY_DEPENDENCIES,
  collectRepositoryDependencyManifest,
  manifestsEqual,
  type CatalogDependencyKind,
  type CatalogDependencyRow,
  type RepositoryDependencyManifest,
} from "./agent-compose-consolidation-preflight-manifest";
import {
  fingerprintMember,
  fingerprintSortedSet,
} from "./agent-compose-consolidation-preflight-fingerprint";
import {
  PREFLIGHT_OUTPUT_ALLOWLIST,
  SanitizedPreflightError,
  classifyPreflightInventory,
  executeAgentComposeConsolidationPreflight,
  sanitizedFailureResult,
  withReadOnlySnapshot,
  type DanglingInventoryRow,
  type HeadInventoryRow,
  type IdentityInventoryRow,
  type PreflightCapabilities,
  type PreflightClassificationOptions,
  type PreflightInventory,
  type VersionInventoryRow,
} from "./agent-compose-consolidation-preflight";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(dirname, "..");
const repositoryRoot = path.resolve(dirname, "../../../..");
const testDatabase = "agent_compose_consolidation_preflight_test";

const capabilities: PreflightCapabilities = {
  serverVersionClassification: "supported",
  transactionReadOnly: true,
  isolationLevel: "repeatable read",
  lockTimeoutMs: 1000,
  statementTimeoutMs: 30000,
  requiredExtensionCount: 0,
};

const emptyCatalog: Record<CatalogDependencyKind, readonly string[]> = {
  constraints: [],
  defaults: [],
  foreignKeys: [],
  functions: [],
  indexes: [],
  otherDependents: [],
  reviewedNonFk: [],
  rewriteDependents: [],
  triggers: [],
};

const emptyRepository: RepositoryDependencyManifest = {
  schemaImports: [],
  legacyIdentifiers: [],
  rawTableLiterals: [],
  nonTypeScriptConsumers: [],
  transitionValidators: [],
};

function emptyInventory(
  overrides: Partial<PreflightInventory> = {},
): PreflightInventory {
  return {
    identity: [],
    versions: [],
    heads: [],
    runs: [],
    checkpoints: [],
    danglingStart: [],
    danglingEnd: [],
    catalogDependencies: [],
    ...overrides,
  };
}

function classificationOptions(
  args: {
    readonly approvedIds?: readonly string[];
    readonly expectedDanglingHeadCount?: number;
  } = {},
): PreflightClassificationOptions {
  const approvedIds = args.approvedIds ?? [];
  return {
    approvedArtifactMemberDigests: approvedIds.map((id) => {
      return fingerprintMember("approved-artifact-member", id);
    }),
    approvedArtifactSetDigest: fingerprintSortedSet(
      "approved-artifact-set",
      approvedIds,
    ).digest,
    expectedApprovedArtifactCount: approvedIds.length,
    expectedDanglingHeadCount: args.expectedDanglingHeadCount ?? 0,
    expectedCatalogDependencies: emptyCatalog,
    expectedRepositoryDependencies: emptyRepository,
    observedRepositoryDependencies: emptyRepository,
  };
}

function identityRow(
  id: string,
  overrides: Partial<IdentityInventoryRow> = {},
): IdentityInventoryRow {
  return {
    id,
    composePresent: true,
    zeroPresent: true,
    orgMismatch: false,
    ownerMismatch: false,
    nameMismatch: false,
    createdRelation: "equal",
    updatedSource: "equal",
    ...overrides,
  };
}

function gatePresent(
  result: { readonly failureGates: readonly string[] },
  gate: string,
): void {
  assert.ok(result.failureGates.includes(gate), `missing gate ${gate}`);
}

function testIdentityAndApprovedArtifacts(): void {
  const matched = identityRow("00000000-0000-4000-8000-000000000001");
  const exact = classifyPreflightInventory(
    capabilities,
    emptyInventory({ identity: [matched] }),
    classificationOptions(),
  );
  assert.equal(exact.status, "passed");
  assert.equal(exact.identity.matched.count, 1);

  const mismatchCases = [
    ["identity.org_mismatch", { orgMismatch: true }],
    ["identity.owner_mismatch", { ownerMismatch: true }],
    ["identity.name_mismatch", { nameMismatch: true }],
  ] as const;
  for (const [gate, override] of mismatchCases) {
    const result = classifyPreflightInventory(
      capabilities,
      emptyInventory({ identity: [identityRow(matched.id, override)] }),
      classificationOptions(),
    );
    gatePresent(result, gate);
  }
  const zeroOnly = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [identityRow(matched.id, { composePresent: false })],
    }),
    classificationOptions(),
  );
  gatePresent(zeroOnly, "identity.zero_only");
  const timestampClasses = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [
        identityRow("00000000-0000-4000-8000-000000000002", {
          createdRelation: "zeroEarlier",
          updatedSource: "compose",
        }),
        identityRow("00000000-0000-4000-8000-000000000003", {
          createdRelation: "zeroLater",
          updatedSource: "zero",
        }),
      ],
    }),
    classificationOptions(),
  );
  assert.equal(
    timestampClasses.identity.createdTimestamps.zeroEarlier.count,
    1,
  );
  assert.equal(timestampClasses.identity.createdTimestamps.zeroLater.count, 1);
  assert.equal(timestampClasses.identity.updatedTimestamps.compose.count, 1);
  assert.equal(timestampClasses.identity.updatedTimestamps.zero.count, 1);

  const approvedIds = Array.from({ length: 6 }, (_, index) => {
    return `00000000-0000-4000-8000-${(index + 10).toString().padStart(12, "0")}`;
  });
  const composeOnly = approvedIds.map((id) => {
    return identityRow(id, { zeroPresent: false });
  });
  const six = classifyPreflightInventory(
    capabilities,
    emptyInventory({ identity: composeOnly }),
    classificationOptions({ approvedIds }),
  );
  assert.equal(six.status, "passed");
  assert.equal(
    six.identity.approvedComposeOnlyArtifacts.classification,
    "exact",
  );

  const seventhId = "00000000-0000-4000-8000-000000000099";
  const seven = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [
        ...composeOnly,
        identityRow(seventhId, { zeroPresent: false }),
      ],
    }),
    classificationOptions({ approvedIds }),
  );
  gatePresent(seven, "identity.approved_artifact_drift");
  assert.equal(seven.identity.approvedComposeOnlyArtifacts.unexpected.count, 1);

  const replacement = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [
        ...composeOnly.slice(0, 5),
        identityRow(seventhId, { zeroPresent: false }),
      ],
    }),
    classificationOptions({ approvedIds }),
  );
  gatePresent(replacement, "identity.approved_artifact_drift");
  assert.equal(
    replacement.identity.approvedComposeOnlyArtifacts
      .missingApprovedMemberCount,
    1,
  );

  const digestDrift = classifyPreflightInventory(
    capabilities,
    emptyInventory({ identity: composeOnly }),
    {
      ...classificationOptions({ approvedIds }),
      approvedArtifactSetDigest: "0".repeat(64),
    },
  );
  gatePresent(digestDrift, "identity.approved_artifact_drift");
}

function canonicalVersion(
  name: string,
  composeId: string | null,
  creatorPresent: boolean,
): VersionInventoryRow {
  const content = buildZeroAgentComposeContent(name);
  return {
    id: computeComposeVersionId(content),
    composeId,
    composeExists: composeId !== null,
    creatorPresent,
    content,
  };
}

function testVersionHeadRunAndCheckpointClassifications(): void {
  const firstAgent = "00000000-0000-4000-8000-000000000201";
  const secondAgent = "00000000-0000-4000-8000-000000000202";
  const version = canonicalVersion("shared-agent", firstAgent, true);
  const heads: HeadInventoryRow[] = [firstAgent, secondAgent].map(
    (composeId) => {
      return {
        composeId,
        headVersionId: version.id,
        versionPresent: true,
        insertionComposeId: firstAgent,
      };
    },
  );
  const shared = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [identityRow(firstAgent), identityRow(secondAgent)],
      versions: [version],
      heads,
      runs: [
        {
          id: "00000000-0000-4000-8000-000000000211",
          versionId: version.id,
          versionPresent: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000212",
          versionId: version.id,
          versionPresent: true,
        },
      ],
      checkpoints: [
        {
          id: "00000000-0000-4000-8000-000000000221",
          snapshot: { agentComposeVersionId: version.id },
        },
        {
          id: "00000000-0000-4000-8000-000000000222",
          snapshot: { agentComposeVersionId: version.id },
        },
      ],
    }),
    classificationOptions(),
  );
  assert.equal(shared.status, "passed");
  assert.equal(shared.heads.sharedHashes.count, 1);
  assert.equal(shared.heads.crossComposeInsertionProvenanceAgentIds.count, 1);
  assert.equal(shared.runs.sharedVersionHashes.count, 1);
  assert.equal(shared.runs.headReferencedVersionHashes.count, 1);
  assert.equal(shared.checkpoints.sharedVersionHashes.count, 1);
  assert.equal(shared.checkpoints.runReferencedVersionHashes.count, 1);
  assert.equal(shared.checkpoints.headReferencedVersionHashes.count, 1);

  const missingHash = "f".repeat(64);
  const missingReferences = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      runs: [
        {
          id: "00000000-0000-4000-8000-000000000231",
          versionId: missingHash,
          versionPresent: false,
        },
      ],
      checkpoints: [
        {
          id: "00000000-0000-4000-8000-000000000232",
          snapshot: { agentComposeVersionId: missingHash },
        },
        {
          id: "00000000-0000-4000-8000-000000000233",
          snapshot: { agentComposeVersionId: "invalid" },
        },
      ],
    }),
    classificationOptions(),
  );
  gatePresent(missingReferences, "runs.missing_version");
  gatePresent(missingReferences, "checkpoints.missing_version");
  gatePresent(missingReferences, "checkpoints.invalid_reference");

  const legacyContent = buildZeroAgentComposeContent("legacy-shape") as {
    agents: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;
  legacyContent.agents["legacy-shape"]!.description = "legacy";
  const legacyVersion: VersionInventoryRow = {
    id: computeComposeVersionId(legacyContent),
    composeId: null,
    composeExists: false,
    creatorPresent: false,
    content: legacyContent,
  };
  const contentClasses = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      versions: [
        legacyVersion,
        {
          ...legacyVersion,
          id: "e".repeat(64),
          content: { unsupported: true },
        },
      ],
    }),
    classificationOptions(),
  );
  assert.equal(contentClasses.versions.content.nonCanonicalLegacy.count, 1);
  assert.equal(contentClasses.versions.content.unsupportedOrInvalid.count, 1);
  assert.equal(contentClasses.versions.content.hashMismatches.count, 1);

  const provenanceVersions = [
    canonicalVersion("provenance-one", firstAgent, true),
    canonicalVersion("provenance-two", firstAgent, false),
    canonicalVersion("provenance-three", null, true),
    canonicalVersion("provenance-four", null, false),
  ];
  const provenance = classifyPreflightInventory(
    capabilities,
    emptyInventory({ versions: provenanceVersions }),
    classificationOptions(),
  );
  assert.equal(provenance.status, "passed");
  assert.equal(
    provenance.versions.provenance.composePresentCreatorPresent.count,
    1,
  );
  assert.equal(
    provenance.versions.provenance.composePresentCreatorNull.count,
    1,
  );
  assert.equal(
    provenance.versions.provenance.composeNullCreatorPresent.count,
    1,
  );
  assert.equal(provenance.versions.provenance.composeNullCreatorNull.count, 1);

  const missingComposeId = "00000000-0000-4000-8000-000000000203";
  const orphanVersions = [
    canonicalVersion("orphan-version-one", missingComposeId, true),
    canonicalVersion("orphan-version-two", missingComposeId, true),
  ].map((orphanVersion) => {
    return { ...orphanVersion, composeExists: false };
  });
  const orphanCompose = classifyPreflightInventory(
    capabilities,
    emptyInventory({ versions: orphanVersions }),
    classificationOptions(),
  );
  gatePresent(orphanCompose, "versions.orphan_compose");
  assert.deepEqual(
    orphanCompose.versions.orphanComposeIds,
    fingerprintSortedSet("versions:orphan-compose-ids", [missingComposeId]),
  );
}

function danglingRow(args: {
  readonly composeId: string;
  readonly name: string | null;
  readonly exact?: boolean;
}): DanglingInventoryRow {
  const exactHash =
    args.name === null
      ? "a".repeat(64)
      : computeComposeVersionId(buildZeroAgentComposeContent(args.name));
  return {
    composeId: args.composeId,
    recordedHash: args.exact === false ? "b".repeat(64) : exactHash,
    agentName: args.name,
  };
}

function testDanglingClassifications(): void {
  const composeId = "00000000-0000-4000-8000-000000000301";
  const exactRow = danglingRow({ composeId, name: "dangling-agent" });
  const head: HeadInventoryRow = {
    composeId,
    headVersionId: exactRow.recordedHash,
    versionPresent: false,
    insertionComposeId: null,
  };
  const exact = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [identityRow(composeId)],
      heads: [head],
      danglingStart: [exactRow],
      danglingEnd: [exactRow],
    }),
    classificationOptions({ expectedDanglingHeadCount: 1 }),
  );
  assert.equal(exact.status, "passed");
  assert.equal(exact.danglingHeads.exact.count, 1);

  const nonExactRow = danglingRow({
    composeId,
    name: "dangling-agent",
    exact: false,
  });
  const nonExact = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      heads: [{ ...head, headVersionId: nonExactRow.recordedHash }],
      danglingStart: [nonExactRow],
      danglingEnd: [nonExactRow],
    }),
    classificationOptions({ expectedDanglingHeadCount: 1 }),
  );
  gatePresent(nonExact, "dangling.non_exact");

  const missingIdentityRow = danglingRow({ composeId, name: null });
  const missingIdentity = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      danglingStart: [missingIdentityRow],
      danglingEnd: [missingIdentityRow],
    }),
    classificationOptions({ expectedDanglingHeadCount: 1 }),
  );
  gatePresent(missingIdentity, "dangling.missing_identity");

  const drift = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      danglingStart: [exactRow],
      danglingEnd: [{ ...exactRow, recordedHash: "c".repeat(64) }],
    }),
    classificationOptions({ expectedDanglingHeadCount: 1 }),
  );
  gatePresent(drift, "dangling.snapshot_drift");
}

function testDependencyDriftAndDeterminism(): void {
  for (const kind of CATALOG_DEPENDENCY_KINDS) {
    const result = classifyPreflightInventory(
      capabilities,
      emptyInventory({
        catalogDependencies: [{ kind, entry: `unexpected-${kind}` }],
      }),
      classificationOptions(),
    );
    gatePresent(result, `dependencies.catalog.${kind}`);
  }

  const repositoryKinds = [
    "schemaImports",
    "legacyIdentifiers",
    "rawTableLiterals",
    "nonTypeScriptConsumers",
    "transitionValidators",
  ] as const;
  for (const kind of repositoryKinds) {
    const observed = { ...emptyRepository, [kind]: ["unexpected-consumer"] };
    const result = classifyPreflightInventory(capabilities, emptyInventory(), {
      ...classificationOptions(),
      observedRepositoryDependencies: observed,
    });
    gatePresent(result, `dependencies.repository.${kind}`);
  }

  const rows = [
    identityRow("00000000-0000-4000-8000-000000000402"),
    identityRow("00000000-0000-4000-8000-000000000401"),
  ];
  const forward = classifyPreflightInventory(
    capabilities,
    emptyInventory({ identity: rows }),
    classificationOptions(),
  );
  const reverse = classifyPreflightInventory(
    capabilities,
    emptyInventory({ identity: [...rows].reverse() }),
    classificationOptions(),
  );
  assert.deepEqual(reverse, forward);
}

function testOutputRedaction(): void {
  const rawId = "00000000-0000-4000-8000-000000000501";
  const rawName = "never-emit-agent-name";
  const dangling = danglingRow({ composeId: rawId, name: rawName });
  const result = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      versions: [
        {
          id: "d".repeat(64),
          composeId: null,
          composeExists: false,
          creatorPresent: false,
          content: { payload: "never-emit-version-content" },
        },
      ],
      danglingStart: [dangling],
      danglingEnd: [dangling],
    }),
    classificationOptions({ expectedDanglingHeadCount: 1 }),
  );
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    rawId,
    rawName,
    "never-emit-version-content",
    "OKOU_TOKEN",
    "user_clerk_fixture",
    "postgresql://user:secret@host/database",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const failure = JSON.stringify(
    sanitizedFailureResult(
      new Error("postgresql://user:secret@host/database never-emit-agent-name"),
    ),
  );
  assert.equal(failure.includes("postgresql://"), false);
  assert.equal(failure.includes(rawName), false);
  assert.deepEqual(Object.keys(result), [
    "schemaVersion",
    "status",
    "failureGates",
    "capabilities",
    "identity",
    "versions",
    "heads",
    "runs",
    "checkpoints",
    "danglingHeads",
    "dependencies",
  ]);
  assert.deepEqual(outputPaths(result), [...PREFLIGHT_OUTPUT_ALLOWLIST]);
  assertSafeAggregateValues(result);
}

function assertSafeAggregateValues(value: unknown, pathPrefix = ""): void {
  if (Array.isArray(value)) {
    assert.equal(pathPrefix, "failureGates");
    for (const gate of value) {
      assert.match(String(gate), /^[A-Za-z]+(?:[._][A-Za-z]+)*$/u);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertSafeAggregateValues(
        child,
        pathPrefix ? `${pathPrefix}.${key}` : key,
      );
    }
    return;
  }
  if (typeof value === "number") {
    assert.equal(Number.isSafeInteger(value) && value >= 0, true);
    return;
  }
  if (typeof value === "boolean") return;
  assert.equal(typeof value, "string");
  if (pathPrefix.endsWith(".digest") || pathPrefix.endsWith("Digest")) {
    assert.match(value as string, /^[0-9a-f]{64}$/u);
    return;
  }
  const allowedClassifications = new Set([
    "vm0.agent-compose-consolidation-preflight.v1",
    "passed",
    "failed",
    "exact",
    "drift",
    "stable",
    "supported",
    "repeatable read",
  ]);
  assert.equal(allowedClassifications.has(value as string), true);
}

function outputPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return [`${prefix}[]`];
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .flatMap(([key, child]) => {
        return outputPaths(child, prefix ? `${prefix}.${key}` : key);
      })
      .sort();
  }
  return [prefix];
}

async function testRepositoryAndWorkflowValidators(): Promise<void> {
  const observed = await collectRepositoryDependencyManifest(repositoryRoot);
  assert.equal(
    manifestsEqual(EXPECTED_REPOSITORY_DEPENDENCIES, observed),
    true,
  );

  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-compose-preflight-manifest-"),
  );
  try {
    const workflowDirectory = path.join(fixtureRoot, ".github/workflows");
    const sourceDirectory = path.join(fixtureRoot, "turbo/apps/api/src");
    const docsDirectory = path.join(fixtureRoot, "turbo/packages/db");
    await fs.mkdir(workflowDirectory, { recursive: true });
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.mkdir(docsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(docsDirectory, "MIGRATIONS.md"),
      "<!-- vm0-transition-validator:fixture-validator -->\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(sourceDirectory, "reviewed.ts"),
      'import { agentComposes } from "@okouai/db/schema/agent-compose";\nvoid agentComposes;\n',
      "utf8",
    );
    const reviewed = await collectRepositoryDependencyManifest(fixtureRoot);
    await fs.writeFile(
      path.join(sourceDirectory, "unexpected.ts"),
      "export const agentComposeVersionId = 'unexpected';\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workflowDirectory, "unexpected.yml"),
      "run: psql agent_compose_versions\n",
      "utf8",
    );
    const drifted = await collectRepositoryDependencyManifest(fixtureRoot);
    assert.equal(manifestsEqual(reviewed, drifted), false);
    assert.equal(
      drifted.legacyIdentifiers.length,
      reviewed.legacyIdentifiers.length + 1,
    );
    assert.equal(
      drifted.nonTypeScriptConsumers.length,
      reviewed.nonTypeScriptConsumers.length + 1,
    );
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }

  const workflow = await fs.readFile(
    path.join(
      repositoryRoot,
      ".github/workflows/agent-compose-consolidation-preflight.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\s*$/mu);
  assert.match(workflow, /^ {4}environment: production$/mu);
  assert.match(workflow, /^ {10}ref: main$/mu);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u,
  );
  assert.match(workflow, /ghcr\.io\/vm0-ai\/vm0-toolchain:20260622/u);
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.match(workflow, /\[\[ -z "\$database_url" \|\|/u);
  assert.match(workflow, /"\$database_url" == \*\$'\\n'\*/u);
  assert.match(workflow, /"\$database_url" == \*\$'\\r'\*/u);
  assert.match(workflow, /"\$database_url" != postgres:\/\/\*/u);
  assert.match(workflow, /"\$database_url" != postgresql:\/\/\*/u);
  assert.ok(
    workflow.indexOf('if [[ -z "$database_url"') <
      workflow.indexOf('>> "$GITHUB_OUTPUT"'),
  );
  assert.match(workflow, /scripts\/agent-compose-consolidation-preflight\.ts/u);
  assert.equal(
    /pull_request:|schedule:|actions\/upload-artifact/iu.test(workflow),
    false,
  );
  assert.equal(/--apply|fallback|REPORT_PATH/iu.test(workflow), false);

  const service = await fs.readFile(
    path.join(
      repositoryRoot,
      "turbo/apps/api/src/signals/services/agent-compose.service.ts",
    ),
    "utf8",
  );
  const contentOwner = await fs.readFile(
    path.join(
      repositoryRoot,
      "turbo/apps/api/src/signals/services/agent-compose-content.ts",
    ),
    "utf8",
  );
  assert.equal(
    service.includes("function buildZeroAgentComposeContent"),
    false,
  );
  assert.equal(service.includes("function computeComposeVersionId"), false);
  assert.equal(
    contentOwner.match(/function buildZeroAgentComposeContent/gu)?.length,
    1,
  );
  assert.equal(
    contentOwner.match(/function computeComposeVersionId/gu)?.length,
    1,
  );
}

function databaseUrlFor(baseUrl: URL, database: string): string {
  const result = new URL(baseUrl);
  result.pathname = `/${database}`;
  return result.toString();
}

async function catalogRows(client: Client): Promise<CatalogDependencyRow[]> {
  const result = await client.query<CatalogDependencyRow>(
    CATALOG_DEPENDENCY_QUERY,
  );
  return result.rows;
}

function catalogCount(
  rows: readonly CatalogDependencyRow[],
  kind: CatalogDependencyKind,
): number {
  return rows.filter((row) => {
    return row.kind === kind;
  }).length;
}

async function testDatabaseBoundaries(databaseUrl: string): Promise<void> {
  const sourceUrl = new URL(databaseUrl);
  const admin = new Client({
    connectionString: databaseUrlFor(sourceUrl, "postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
  const testUrl = databaseUrlFor(sourceUrl, testDatabase);

  try {
    execFileSync("tsx", [path.join(dirname, "migrate.ts")], {
      cwd: packageDirectory,
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    const client = new Client({ connectionString: testUrl });
    const writer = new Client({ connectionString: testUrl });
    await client.connect();
    await writer.connect();
    try {
      const emptyApprovedDigest = fingerprintSortedSet(
        "approved-artifact-set",
        [],
      ).digest;
      const executionOptions: PreflightClassificationOptions = {
        approvedArtifactMemberDigests: [],
        approvedArtifactSetDigest: emptyApprovedDigest,
        expectedApprovedArtifactCount: 0,
        expectedDanglingHeadCount: 0,
      };
      const first = await executeAgentComposeConsolidationPreflight({
        connectionString: testUrl,
        repositoryRoot,
        classification: executionOptions,
      });
      const second = await executeAgentComposeConsolidationPreflight({
        connectionString: testUrl,
        repositoryRoot,
        classification: executionOptions,
      });
      assert.equal(first.status, "passed");
      assert.deepEqual(second, first);

      await withReadOnlySnapshot(client, {}, async () => {
        await assert.rejects(
          client.query(`INSERT INTO "agent_composes" (
            "user_id", "name", "org_id"
          ) VALUES ('readonly-user', 'readonly-agent', 'readonly-org')`),
          (error: unknown) => {
            return (error as { readonly code?: unknown }).code === "25006";
          },
        );
      });

      await assert.rejects(
        withReadOnlySnapshot(client, { statementTimeoutMs: 25 }, async () => {
          await client.query("SELECT pg_sleep(0.2)");
        }),
        (error: unknown) => {
          return (
            error instanceof SanitizedPreflightError &&
            error.gate === "probe.statement_timeout"
          );
        },
      );

      const abortController = new AbortController();
      abortController.abort();
      await assert.rejects(
        withReadOnlySnapshot(
          client,
          { signal: abortController.signal },
          async () => {
            return undefined;
          },
        ),
        (error: unknown) => {
          return (
            error instanceof SanitizedPreflightError &&
            error.gate === "probe.cancelled"
          );
        },
      );

      const concurrentAgentId = "00000000-0000-4000-8000-000000027613";
      const firstHead = "a".repeat(64);
      const secondHead = "b".repeat(64);
      await writer.query(
        `INSERT INTO "agent_composes" (
           "id", "user_id", "name", "head_version_id", "org_id"
         ) VALUES ($1, 'snapshot-user', 'snapshot-agent', $2, 'snapshot-org')`,
        [concurrentAgentId, firstHead],
      );
      await writer.query(
        `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
         VALUES ($1, 'snapshot-org', 'snapshot-user', 'snapshot-agent')`,
        [concurrentAgentId],
      );
      await withReadOnlySnapshot(client, {}, async () => {
        const start = await client.query<{ head: string }>(
          `SELECT "head_version_id" AS "head" FROM "agent_composes"
           WHERE "id" = $1`,
          [concurrentAgentId],
        );
        await writer.query(
          `UPDATE "agent_composes" SET "head_version_id" = $2 WHERE "id" = $1`,
          [concurrentAgentId, secondHead],
        );
        const end = await client.query<{ head: string }>(
          `SELECT "head_version_id" AS "head" FROM "agent_composes"
           WHERE "id" = $1`,
          [concurrentAgentId],
        );
        assert.deepEqual(end.rows, start.rows);
        assert.equal(start.rows[0]?.head, firstHead);
      });
      const live = await client.query<{ head: string }>(
        `SELECT "head_version_id" AS "head" FROM "agent_composes"
         WHERE "id" = $1`,
        [concurrentAgentId],
      );
      assert.equal(live.rows[0]?.head, secondHead);

      const baselineCatalog = await catalogRows(client);
      for (const kind of CATALOG_DEPENDENCY_KINDS) {
        assert.equal(
          catalogCount(baselineCatalog, kind),
          EXPECTED_CATALOG_DEPENDENCIES[kind].length,
        );
      }

      await client.query(`ALTER TABLE "agent_composes"
        ADD CONSTRAINT "preflight_unexpected_name_check"
        CHECK ("name" IS NOT NULL) NOT VALID`);
      assert.equal(
        catalogCount(await catalogRows(client), "constraints"),
        catalogCount(baselineCatalog, "constraints") + 1,
      );
      await client.query(`ALTER TABLE "agent_composes"
        DROP CONSTRAINT "preflight_unexpected_name_check"`);

      await client.query(`CREATE TABLE "preflight_unexpected_fk" (
        "agent_id" uuid REFERENCES "zero_agents" ("id")
      )`);
      assert.equal(
        catalogCount(await catalogRows(client), "foreignKeys"),
        catalogCount(baselineCatalog, "foreignKeys") + 1,
      );
      await client.query(`DROP TABLE "preflight_unexpected_fk"`);

      await client.query(`CREATE TABLE "preflight_unexpected_checkpoint" (
        "agent_compose_snapshot" jsonb
      )`);
      assert.equal(
        catalogCount(await catalogRows(client), "reviewedNonFk"),
        catalogCount(baselineCatalog, "reviewedNonFk") + 1,
      );
      await client.query(`DROP TABLE "preflight_unexpected_checkpoint"`);

      await client.query(`ALTER TABLE "agent_composes"
        ALTER COLUMN "head_version_id" SET DEFAULT '${"c".repeat(64)}'`);
      assert.equal(
        catalogCount(await catalogRows(client), "defaults"),
        catalogCount(baselineCatalog, "defaults") + 1,
      );
      await client.query(`ALTER TABLE "agent_composes"
        ALTER COLUMN "head_version_id" DROP DEFAULT`);

      await client.query(`CREATE INDEX "preflight_unexpected_head_idx"
        ON "agent_composes" ("head_version_id")`);
      assert.equal(
        catalogCount(await catalogRows(client), "indexes"),
        catalogCount(baselineCatalog, "indexes") + 1,
      );
      await client.query(`DROP INDEX "preflight_unexpected_head_idx"`);

      await client.query(`CREATE VIEW "preflight_unexpected_agent_view" AS
        SELECT "id" FROM "agent_composes"`);
      await client.query(`CREATE VIEW "preflight_unexpected_nested_view" AS
        SELECT "id" FROM "preflight_unexpected_agent_view"`);
      const viewDrift = await catalogRows(client);
      assert.equal(
        catalogCount(viewDrift, "rewriteDependents"),
        catalogCount(baselineCatalog, "rewriteDependents") + 2,
      );
      gatePresent(
        classifyPreflightInventory(
          capabilities,
          emptyInventory({ catalogDependencies: viewDrift }),
          {
            ...classificationOptions(),
            expectedCatalogDependencies: EXPECTED_CATALOG_DEPENDENCIES,
          },
        ),
        "dependencies.catalog.rewriteDependents",
      );
      await client.query(`DROP VIEW "preflight_unexpected_nested_view"`);
      await client.query(`DROP VIEW "preflight_unexpected_agent_view"`);

      await client.query(
        `CREATE MATERIALIZED VIEW "preflight_unexpected_agent_materialized" AS
         SELECT "id" FROM "agent_composes" WITH NO DATA`,
      );
      assert.equal(
        catalogCount(await catalogRows(client), "rewriteDependents"),
        catalogCount(baselineCatalog, "rewriteDependents") + 1,
      );
      await client.query(
        `DROP MATERIALIZED VIEW "preflight_unexpected_agent_materialized"`,
      );

      await client.query(`CREATE RULE "preflight_unexpected_agent_rule" AS
        ON DELETE TO "agent_composes" DO INSTEAD NOTHING`);
      assert.equal(
        catalogCount(await catalogRows(client), "rewriteDependents"),
        catalogCount(baselineCatalog, "rewriteDependents") + 1,
      );
      await client.query(
        `DROP RULE "preflight_unexpected_agent_rule" ON "agent_composes"`,
      );

      await client.query(
        `CREATE SEQUENCE "preflight_unexpected_owned_sequence"
         OWNED BY "agent_composes"."id"`,
      );
      const otherDrift = await catalogRows(client);
      assert.equal(
        catalogCount(otherDrift, "otherDependents"),
        catalogCount(baselineCatalog, "otherDependents") + 1,
      );
      gatePresent(
        classifyPreflightInventory(
          capabilities,
          emptyInventory({ catalogDependencies: otherDrift }),
          {
            ...classificationOptions(),
            expectedCatalogDependencies: EXPECTED_CATALOG_DEPENDENCIES,
          },
        ),
        "dependencies.catalog.otherDependents",
      );
      await client.query(`DROP SEQUENCE "preflight_unexpected_owned_sequence"`);

      await client.query(
        `CREATE TABLE "preflight_unexpected_composite" (
          "agent" "agent_composes"
        )`,
      );
      assert.equal(
        catalogCount(await catalogRows(client), "otherDependents"),
        catalogCount(baselineCatalog, "otherDependents") + 1,
      );
      await client.query(`DROP TABLE "preflight_unexpected_composite"`);

      await client.query(
        `CREATE TABLE "preflight_unexpected_inherited" ()
         INHERITS ("agent_composes")`,
      );
      assert.equal(
        catalogCount(await catalogRows(client), "otherDependents"),
        catalogCount(baselineCatalog, "otherDependents") + 1,
      );
      await client.query(`DROP TABLE "preflight_unexpected_inherited"`);

      await client.query(`CREATE FUNCTION "preflight_unexpected_trigger"()
        RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RETURN NEW; END
        $body$`);
      await client.query(`CREATE TRIGGER "preflight_unexpected_trigger"
        BEFORE UPDATE ON "agent_composes" FOR EACH ROW
        EXECUTE FUNCTION "preflight_unexpected_trigger"()`);
      const triggerDrift = await catalogRows(client);
      assert.equal(
        catalogCount(triggerDrift, "triggers"),
        catalogCount(baselineCatalog, "triggers") + 1,
      );
      assert.equal(
        catalogCount(triggerDrift, "functions"),
        catalogCount(baselineCatalog, "functions") + 1,
      );
      await client.query(
        `DROP TRIGGER "preflight_unexpected_trigger" ON "agent_composes"`,
      );
      await client.query(`DROP FUNCTION "preflight_unexpected_trigger"()`);
    } finally {
      await client.end();
      await writer.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

export async function validateAgentComposeConsolidationPreflightStatic(): Promise<void> {
  testIdentityAndApprovedArtifacts();
  testVersionHeadRunAndCheckpointClassifications();
  testDanglingClassifications();
  testDependencyDriftAndDeterminism();
  testOutputRedaction();
  await testRepositoryAndWorkflowValidators();
}

export async function validateAgentComposeConsolidationPreflight(): Promise<void> {
  await validateAgentComposeConsolidationPreflightStatic();

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await testDatabaseBoundaries(databaseUrl);
  console.log("agent compose consolidation preflight passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentComposeConsolidationPreflight().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
