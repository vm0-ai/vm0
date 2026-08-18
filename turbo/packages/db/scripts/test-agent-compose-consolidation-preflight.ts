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
import { classifyAgentExecutionAuthority } from "../../../apps/api/src/signals/services/agent-execution-authority";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "../../../apps/api/src/signals/services/agent-execution-plan";
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
  HISTORICAL_PRODUCT_BUILDER_VARIANTS,
  buildHistoricalProductBuilderContent,
  computeHistoricalProductBuilderReviewFingerprint,
  isExactHistoricalProductBuilderCandidate,
  type HistoricalProductBuilderCandidate,
} from "../../../apps/api/src/signals/services/historical-product-builder";
import {
  EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST,
  collectRuntimeContentConsumerManifest,
  runtimeContentConsumerManifestsEqual,
} from "./agent-compose-consolidation-preflight-consumers";
import {
  classifyExceptionRefinements,
  type UnclassifiedPrimaryClass,
} from "./agent-compose-consolidation-preflight-refinements";
import { validateLaunchSnapshotRecoverabilityStatic } from "./test-agent-compose-consolidation-preflight-launch-snapshots";
import {
  validateLaunchSnapshotBackfillDatabase,
  validateLaunchSnapshotBackfillStatic,
} from "./test-agent-run-launch-snapshot-backfill";
import {
  PREFLIGHT_OUTPUT_ALLOWLIST,
  SanitizedPreflightError,
  assertPreflightOutputShape,
  classifyPreflightInventory,
  executeAgentComposeConsolidationPreflight,
  sanitizedFailureResult,
  withReadOnlySnapshot,
  type AgentExecutionPlanInventoryRow,
  type DanglingInventoryRow,
  type HeadInventoryRow,
  type IdentityInventoryRow,
  type PreflightCapabilities,
  type PreflightClassificationOptions,
  type PreflightInventory,
  type RunInventoryRow,
  type VersionInventoryRow,
} from "./agent-compose-consolidation-preflight";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(dirname, "..");
const repositoryRoot = path.resolve(dirname, "../../../..");
const testDatabase = "agent_compose_consolidation_preflight_test";
const ACTIVITY_TIME_ZONES = ["UTC", "Asia/Shanghai"] as const;

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
    conversations: [],
    danglingStart: [],
    danglingEnd: [],
    agentExecutionPlans: [],
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

interface MutableAgentDefinition {
  description?: string;
  framework: "claude-code" | "codex";
  volumes?: string[];
  environment?: Record<string, string>;
  instructions?: string;
  skills?: string[];
  experimental_runner?: { group: string };
  experimental_profile?: string;
  firewalls?: unknown;
  futureField?: unknown;
}

interface MutableAgentContent extends Record<string, unknown> {
  version: string;
  agents: Record<string, MutableAgentDefinition>;
  volumes?: Record<
    string,
    { name: string; version: string; optional?: boolean; system?: unknown }
  >;
  artifacts?: { name: string; version?: string; mount_path?: string }[];
  futureField?: unknown;
}

/** Transition-only #28056 test helper; removed by #26938 Stage 8. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mutableAgentContent(name: string): MutableAgentContent {
  return structuredClone(
    buildZeroAgentComposeContent(name),
  ) as MutableAgentContent;
}

function executionPlanRow(args: {
  readonly id: string;
  readonly agentName: string;
  readonly content?: unknown;
  readonly headVersionId?: string | null;
  readonly versionId?: string | null;
  readonly insertionComposeId?: string | null;
  readonly activitySnapshotTime?: Date;
  readonly latestAttributedRunAt?: Date | null;
  readonly activeNonterminalRun?: boolean;
  readonly currentHeadEverExercised?: boolean;
  readonly unknownRunStatus?: boolean;
}): AgentExecutionPlanInventoryRow {
  const content = Object.hasOwn(args, "content")
    ? args.content
    : buildZeroAgentComposeContent(args.agentName);
  const computedVersionId =
    content !== null && typeof content === "object" && !Array.isArray(content)
      ? computeComposeVersionId(content as Record<string, unknown>)
      : "f".repeat(64);
  return {
    id: args.id,
    agentName: args.agentName,
    headVersionId: Object.hasOwn(args, "headVersionId")
      ? (args.headVersionId ?? null)
      : computedVersionId,
    versionId: Object.hasOwn(args, "versionId")
      ? (args.versionId ?? null)
      : computedVersionId,
    insertionComposeId: Object.hasOwn(args, "insertionComposeId")
      ? (args.insertionComposeId ?? null)
      : args.id,
    content,
    activitySnapshotTime:
      args.activitySnapshotTime ?? new Date("2026-08-17T00:00:00.000Z"),
    latestAttributedRunAt: Object.hasOwn(args, "latestAttributedRunAt")
      ? (args.latestAttributedRunAt ?? null)
      : null,
    activeNonterminalRun: args.activeNonterminalRun ?? false,
    currentHeadEverExercised: args.currentHeadEverExercised ?? false,
    unknownRunStatus: args.unknownRunStatus ?? false,
  };
}

function classifyPlanRows(
  rows: readonly AgentExecutionPlanInventoryRow[],
  identityIds: readonly string[] = rows.map((row) => {
    return row.id;
  }),
) {
  return classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [...new Set(identityIds)].map((id) => {
        return identityRow(id);
      }),
      agentExecutionPlans: rows,
    }),
    classificationOptions(),
  );
}

function gatePresent(
  result: { readonly failureGates: readonly string[] },
  gate: string,
): void {
  assert.ok(result.failureGates.includes(gate), `missing gate ${gate}`);
}

function testApplicationOwnedPlanAndCanonicalCompatibility(): void {
  assert.deepEqual(APPLICATION_OWNED_AGENT_EXECUTION_PLAN, {
    framework: { owner: "model-provider", fallback: "claude-code" },
    environment: {
      owners: ["system-identity", "model-provider", "connector", "run"],
      legacyRemovedPrefixes: ["ZERO_"],
      runtimeOverrideKeys: [
        "CLI_PKG_URL",
        "OKOU_AGENT_ID",
        "OKOU_APP_URL",
        "OKOU_TOKEN",
        "OKOU_WEBSITE_TEMPLATE_ARCHIVE_VERSION",
      ],
      legacySerializedBindings: {
        agentId: "OKOU_AGENT_ID",
        token: "OKOU_TOKEN",
      },
    },
    runner: {
      group: {
        owner: "execution-routing-policy",
        fallback: null,
      },
      profile: {
        owner: "resource-policy",
        fallback: "vm0/default",
      },
    },
    instructions: { owner: "agent-storage", enabled: true },
    storage: {
      owners: [
        "system",
        "connector",
        "workflow",
        "request",
        "continuation",
        "session-storage",
      ],
    },
  });

  const exact = buildZeroAgentComposeContent("agent-one");
  assert.equal(
    JSON.stringify(exact),
    '{"version":"1","agents":{"agent-one":{"framework":"claude-code","instructions":"CLAUDE.md","environment":{"OKOU_AGENT_ID":"${{ vars.OKOU_AGENT_ID }}","OKOU_TOKEN":"${{ secrets.OKOU_TOKEN }}"}}}}',
  );
  for (const [name, hash] of [
    ["abc", "95d80f7ce931ac6a5e34b5eb8929dee3244522bf859ac5f4c53e91e3cc3f6c6e"],
    [
      "agent-one",
      "02345310e6913e03cb82d4c68a59f09a335ecd1bb2bf11b9ac4615eeac80ad53",
    ],
    [
      "a".repeat(64),
      "0c0c0c71cca0b457af4182ce1c1db5eab7289eb59e6135b90e46bb42412913bc",
    ],
  ] as const) {
    assert.equal(
      computeComposeVersionId(buildZeroAgentComposeContent(name)),
      hash,
    );
  }
}

function testIdentityAndApprovedArtifacts(): void {
  const matched = identityRow("00000000-0000-4000-8000-000000000001");
  const exact = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [matched],
      agentExecutionPlans: [
        executionPlanRow({ id: matched.id, agentName: "matched-agent" }),
      ],
    }),
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

function runRow(
  id: string,
  versionId: string | null,
  versionPresent: boolean,
  overrides: Partial<RunInventoryRow> = {},
): RunInventoryRow {
  return {
    id,
    versionId,
    versionPresent,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    launchSnapshot: null,
    modelProvider: null,
    selectedModel: null,
    triggerSource: "slack",
    chatThreadPresent: false,
    metadataShape: "product",
    ...overrides,
  };
}

function acceptedV3DomainProjection(
  result: ReturnType<typeof classifyPreflightInventory>,
) {
  return {
    capabilities: result.capabilities,
    agentExecutionPlans: result.agentExecutionPlans,
    identity: result.identity,
    versions: result.versions,
    heads: result.heads,
    runs: result.runs,
    checkpoints: result.checkpoints,
    danglingHeads: result.danglingHeads,
    dependencies: result.dependencies,
  };
}

function testSchemaV3DomainsRemainByteStable(): void {
  const version = canonicalVersion("v3-stability", null, false);
  const runId = "00000000-0000-4000-8000-000000000199";
  const options = classificationOptions();
  const withoutSnapshot = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      versions: [version],
      runs: [runRow(runId, version.id, true)],
    }),
    options,
  );
  const withInvalidSnapshot = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      versions: [version],
      runs: [
        runRow(runId, version.id, true, {
          launchSnapshot: {
            schemaVersion: 1,
            framework: "claude-code",
            runnerProfile: "vm0/default",
            unexpected: true,
          },
          modelProvider: "future-provider",
          selectedModel: "future-model",
        }),
      ],
    }),
    options,
  );
  assert.notDeepEqual(
    withInvalidSnapshot.launchSnapshots,
    withoutSnapshot.launchSnapshots,
  );
  assert.equal(
    JSON.stringify(acceptedV3DomainProjection(withInvalidSnapshot)),
    JSON.stringify(acceptedV3DomainProjection(withoutSnapshot)),
  );
}

/** Transition-only #28056 contract test; removed by #26938 Stage 8. */
function testSchemaV4OutputContractRemainsByteStable(): void {
  const acceptedV4Paths = PREFLIGHT_OUTPUT_ALLOWLIST.filter((outputPath) => {
    return (
      !outputPath.includes(".historicalProductBuilderOrigin.") &&
      !outputPath.includes(".applicationHistoricalProductBuilderEnvironment.")
    );
  });
  assert.equal(acceptedV4Paths.length, 874);
  assert.deepEqual(
    fingerprintSortedSet(
      "agent-compose-consolidation-preflight:v4-output-paths",
      acceptedV4Paths,
    ),
    {
      count: 874,
      digest:
        "24a68ad3c32b2d796e42477c2424a0dd8206f89e6c1ce5f0cdda4d418da47b94",
    },
  );
}

/** Transition-only #28070 contract test; removed by #26938 Stage 8. */
function testSchemaV5OutputContractRemainsByteStable(): void {
  const v6Markers = [
    ".applicationHistoricalProductBuilderEnvironment.",
    ".legacyEnvironmentLineage.",
    ".applicationAuthorityMembershipLineageClosure.",
    ".residualEnvironmentMembershipLineageClosure.",
    ".authorityPartitionClosure.",
    ".authorityDisjointnessClosure.",
  ];
  const acceptedV5Paths = PREFLIGHT_OUTPUT_ALLOWLIST.filter((outputPath) => {
    return !v6Markers.some((marker) => {
      return outputPath.includes(marker);
    });
  });
  assert.deepEqual(
    fingerprintSortedSet(
      "agent-compose-consolidation-preflight:v5-output-paths",
      acceptedV5Paths,
    ),
    {
      count: 971,
      digest:
        "931140875c0a0d3c568166d61a680fedbd219f1d5bdffdbc5a660962263b49e1",
    },
  );
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
      agentExecutionPlans: [
        executionPlanRow({
          id: firstAgent,
          agentName: "shared-agent",
          content: version.content,
          insertionComposeId: firstAgent,
        }),
        executionPlanRow({
          id: secondAgent,
          agentName: "shared-agent",
          content: version.content,
          insertionComposeId: firstAgent,
        }),
      ],
      runs: [
        runRow("00000000-0000-4000-8000-000000000211", version.id, true),
        runRow("00000000-0000-4000-8000-000000000212", version.id, true),
      ],
      checkpoints: [
        {
          id: "00000000-0000-4000-8000-000000000221",
          runId: "00000000-0000-4000-8000-000000000211",
          snapshot: { agentComposeVersionId: version.id },
        },
        {
          id: "00000000-0000-4000-8000-000000000222",
          runId: "00000000-0000-4000-8000-000000000212",
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
        runRow("00000000-0000-4000-8000-000000000231", missingHash, false),
      ],
      checkpoints: [
        {
          id: "00000000-0000-4000-8000-000000000232",
          runId: "00000000-0000-4000-8000-000000000231",
          snapshot: { agentComposeVersionId: missingHash },
        },
        {
          id: "00000000-0000-4000-8000-000000000233",
          runId: "00000000-0000-4000-8000-000000000233",
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
      agentExecutionPlans: [
        executionPlanRow({
          id: composeId,
          agentName: "dangling-agent",
          content: null,
          headVersionId: exactRow.recordedHash,
          versionId: null,
        }),
      ],
      danglingStart: [exactRow],
      danglingEnd: [exactRow],
    }),
    classificationOptions({ expectedDanglingHeadCount: 1 }),
  );
  assert.equal(exact.status, "failed");
  assert.equal(exact.danglingHeads.exact.count, 1);
  assert.equal(exact.agentExecutionPlans.danglingOrMissingHeadVersion.count, 1);

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

function testAgentExecutionPlanClassifications(): void {
  const id = (suffix: number): string => {
    return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  };

  const canonical = classifyPlanRows([
    executionPlanRow({ id: id(601), agentName: "canonical-agent" }),
  ]);
  assert.equal(canonical.status, "passed");
  assert.equal(canonical.agentExecutionPlans.completeSemanticParity.count, 1);
  assert.equal(canonical.agentExecutionPlans.exceptions.count, 0);
  assert.equal(
    canonical.agentExecutionPlans.inventoryClosure.classification,
    "exact",
  );
  assert.equal(
    canonical.agentExecutionPlans.partitionClosure.classification,
    "exact",
  );
  assert.equal(
    canonical.agentExecutionPlans.dimensionUnionClosure.classification,
    "exact",
  );
  const canonicalAuthority = classifyAgentExecutionAuthority(
    executionPlanRow({ id: id(601), agentName: "canonical-agent" }),
  );
  assert.deepEqual(canonicalAuthority, {
    authority: "application",
    classification: "completeSemanticParity",
    dimensions: [],
  });

  const frameworkFallbackContent = (
    name: string,
    variant: "missing" | "unsupported",
  ): MutableAgentContent => {
    const content = mutableAgentContent(name);
    const agent = content.agents[name] as unknown as Record<string, unknown>;
    if (variant === "missing") {
      delete agent.framework;
    } else {
      agent.framework = "future-framework";
    }
    return content;
  };
  const missingFramework = frameworkFallbackContent(
    "missing-framework-agent",
    "missing",
  );
  const unsupportedFramework = frameworkFallbackContent(
    "unsupported-framework-agent",
    "unsupported",
  );
  const missingFrameworkBefore = structuredClone(missingFramework);
  const unsupportedFrameworkBefore = structuredClone(unsupportedFramework);
  const missingFrameworkRow = executionPlanRow({
    id: id(627),
    agentName: "missing-framework-agent",
    content: missingFramework,
  });
  const unsupportedFrameworkRow = executionPlanRow({
    id: id(628),
    agentName: "unsupported-framework-agent",
    content: unsupportedFramework,
  });
  for (const row of [missingFrameworkRow, unsupportedFrameworkRow]) {
    assert.deepEqual(classifyAgentExecutionAuthority(row), {
      authority: "application",
      classification: "applicationFrameworkFallback",
      dimensions: [],
    });
  }
  assert.deepEqual(missingFramework, missingFrameworkBefore);
  assert.deepEqual(unsupportedFramework, unsupportedFrameworkBefore);

  const frameworkFallbackResult = classifyPlanRows([
    executionPlanRow({ id: id(629), agentName: "separate-parity-agent" }),
    missingFrameworkRow,
    unsupportedFrameworkRow,
  ]);
  assert.equal(frameworkFallbackResult.status, "passed");
  assert.equal(
    frameworkFallbackResult.agentExecutionPlans.completeSemanticParity.count,
    1,
  );
  assert.deepEqual(
    frameworkFallbackResult.agentExecutionPlans.applicationFrameworkFallback,
    fingerprintSortedSet(
      "agent-execution-plans:application-framework-fallback-agent-ids",
      [id(627), id(628)],
    ),
  );
  assert.equal(frameworkFallbackResult.agentExecutionPlans.exceptions.count, 0);
  assert.equal(
    frameworkFallbackResult.agentExecutionPlans.partitionClosure.classification,
    "exact",
  );

  const mixedFrameworkFallbackCases: readonly {
    readonly suffix: number;
    readonly name: string;
    readonly agentName?: string;
    readonly mutate: (
      content: MutableAgentContent,
      agent: Record<string, unknown>,
    ) => void;
  }[] = [
    {
      suffix: 630,
      name: "fallback-environment-agent",
      mutate: (_content, agent) => {
        agent.environment = { CUSTOM_RUNTIME_VALUE: "legacy-value" };
      },
    },
    {
      suffix: 631,
      name: "fallback-unknown-agent",
      mutate: (content) => {
        content.futureField = { retained: true };
      },
    },
    {
      suffix: 632,
      name: "fallback-runner-agent",
      mutate: (_content, agent) => {
        agent.experimental_runner = { group: "vm0/custom" };
      },
    },
    {
      suffix: 633,
      name: "fallback-profile-agent",
      mutate: (_content, agent) => {
        agent.experimental_profile = "vm0/large";
      },
    },
    {
      suffix: 634,
      name: "fallback-instructions-agent",
      mutate: (_content, agent) => {
        delete agent.instructions;
      },
    },
    {
      suffix: 635,
      name: "fallback-artifact-agent",
      mutate: (content) => {
        content.artifacts = [{ name: "legacy-artifact" }];
      },
    },
    {
      suffix: 636,
      name: "fallback-volume-agent",
      mutate: (content, agent) => {
        agent.volumes = ["legacy-volume:/data"];
        content.volumes = {
          "legacy-volume": { name: "legacy-storage", version: "latest" },
        };
      },
    },
    {
      suffix: 637,
      name: "fallback-other-name",
      agentName: "fallback-product-name",
      mutate: () => {},
    },
    {
      suffix: 641,
      name: "fallback-ambiguous-agent",
      mutate: (content) => {
        content.agents["fallback-second-agent"] = {
          framework: "claude-code",
        };
      },
    },
  ];
  const mixedFrameworkFallbackRows = mixedFrameworkFallbackCases.map(
    ({ suffix, name, agentName, mutate }) => {
      const content = frameworkFallbackContent(name, "missing");
      mutate(
        content,
        content.agents[name] as unknown as Record<string, unknown>,
      );
      const row = executionPlanRow({
        id: id(suffix),
        agentName: agentName ?? name,
        content,
      });
      assert.deepEqual(classifyAgentExecutionAuthority(row), {
        authority: "version_content",
        classification: "unsupportedOrInvalidContent",
        dimensions: ["unsupportedOrInvalidContent"],
      });
      return row;
    },
  );
  const mixedFrameworkFallbackResult = classifyPlanRows(
    mixedFrameworkFallbackRows,
  );
  assert.equal(
    mixedFrameworkFallbackResult.agentExecutionPlans
      .applicationFrameworkFallback.count,
    0,
  );
  assert.equal(
    mixedFrameworkFallbackResult.agentExecutionPlans.unsupportedOrInvalidContent
      .count,
    mixedFrameworkFallbackRows.length,
  );
  assert.equal(
    mixedFrameworkFallbackResult.agentExecutionPlans.refinements
      .unsupportedOrInvalidContent.primaryPartitionClosure.expected.count,
    mixedFrameworkFallbackRows.length,
  );

  const hashDriftFramework = frameworkFallbackContent(
    "fallback-hash-drift-agent",
    "missing",
  );
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(638),
        agentName: "fallback-hash-drift-agent",
        content: hashDriftFramework,
        headVersionId: "e".repeat(64),
        versionId: "e".repeat(64),
      }),
    ).authority,
    "version_content",
  );
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(639),
        agentName: "fallback-missing-version-agent",
        content: frameworkFallbackContent(
          "fallback-missing-version-agent",
          "missing",
        ),
        versionId: null,
      }),
    ).classification,
    "danglingOrMissingHeadVersion",
  );
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(642),
        agentName: "fallback-dangling-head-agent",
        content: frameworkFallbackContent(
          "fallback-dangling-head-agent",
          "missing",
        ),
        headVersionId: null,
      }),
    ).classification,
    "danglingOrMissingHeadVersion",
  );
  const duplicateFrameworkFallbackRow = executionPlanRow({
    id: id(640),
    agentName: "fallback-duplicate-agent",
    content: frameworkFallbackContent("fallback-duplicate-agent", "missing"),
  });
  const duplicateFrameworkFallbackResult = classifyPlanRows([
    duplicateFrameworkFallbackRow,
    duplicateFrameworkFallbackRow,
  ]);
  assert.equal(
    duplicateFrameworkFallbackResult.agentExecutionPlans
      .applicationFrameworkFallback.count,
    0,
  );
  assert.equal(
    duplicateFrameworkFallbackResult.agentExecutionPlans.unclassifiedContent
      .count,
    1,
  );

  const injected = mutableAgentContent("injected-agent");
  injected.agents["injected-agent"]!.environment = {
    ZERO_AGENT_ID: "legacy-agent-id",
    ZERO_TOKEN: "legacy-token",
    CLI_PKG_URL: "legacy-cli-package",
    OKOU_AGENT_ID: "legacy-okou-agent-id",
    OKOU_APP_URL: "legacy-app-url",
    OKOU_TOKEN: "legacy-okou-token",
    OKOU_WEBSITE_TEMPLATE_ARCHIVE_VERSION: "legacy-template-version",
  };
  const injectedResult = classifyPlanRows([
    executionPlanRow({
      id: id(602),
      agentName: "injected-agent",
      content: injected,
    }),
  ]);
  assert.equal(injectedResult.status, "passed");
  assert.equal(
    injectedResult.agentExecutionPlans.completeSemanticParity.count,
    1,
  );
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(602),
        agentName: "injected-agent",
        content: injected,
      }),
    ).authority,
    "application",
  );

  const ignoredLegacyFields = mutableAgentContent("ignored-fields-agent");
  ignoredLegacyFields.version = "legacy-version";
  Object.assign(ignoredLegacyFields.agents["ignored-fields-agent"]!, {
    description: "not used to launch",
    skills: ["retired-skill"],
    firewalls: { retired: { permissions: "all" } },
  });
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(603),
        agentName: "ignored-fields-agent",
        content: ignoredLegacyFields,
      }),
    ]).status,
    "passed",
  );

  const environment = mutableAgentContent("environment-agent");
  environment.agents["environment-agent"]!.environment = {
    CUSTOM_RUNTIME_VALUE: "raw-secret-value",
  };
  const environmentResult = classifyPlanRows([
    executionPlanRow({
      id: id(604),
      agentName: "environment-agent",
      content: environment,
    }),
  ]);
  assert.equal(
    environmentResult.agentExecutionPlans.systemEnvironmentDifferences.count,
    1,
  );
  assert.deepEqual(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(604),
        agentName: "environment-agent",
        content: environment,
      }),
    ),
    {
      authority: "version_content",
      classification: "systemEnvironmentDifferences",
      dimensions: ["systemEnvironmentDifferences"],
    },
  );

  const framework = mutableAgentContent("framework-agent");
  framework.agents["framework-agent"]!.framework = "codex";
  const frameworkResult = classifyPlanRows([
    executionPlanRow({
      id: id(605),
      agentName: "framework-agent",
      content: framework,
    }),
  ]);
  assert.equal(
    frameworkResult.agentExecutionPlans.frameworkOrFallbackDifferences.count,
    1,
  );
  assert.equal(
    APPLICATION_OWNED_AGENT_EXECUTION_PLAN.framework.owner,
    "model-provider",
  );
  assert.equal(
    APPLICATION_OWNED_AGENT_EXECUTION_PLAN.framework.fallback,
    "claude-code",
  );

  const explicitGroup = mutableAgentContent("runner-group-agent");
  explicitGroup.agents["runner-group-agent"]!.experimental_runner = {
    group: "vm0/default",
  };
  const explicitGroupResult = classifyPlanRows([
    executionPlanRow({
      id: id(606),
      agentName: "runner-group-agent",
      content: explicitGroup,
    }),
  ]);
  assert.equal(
    explicitGroupResult.agentExecutionPlans.runnerGroupPolicyDifferences.count,
    1,
  );

  const explicitDefaultProfile = mutableAgentContent("default-profile-agent");
  explicitDefaultProfile.agents["default-profile-agent"]!.experimental_profile =
    "vm0/default";
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(607),
        agentName: "default-profile-agent",
        content: explicitDefaultProfile,
      }),
    ]).status,
    "passed",
  );
  const customProfile = mutableAgentContent("custom-profile-agent");
  customProfile.agents["custom-profile-agent"]!.experimental_profile =
    "vm0/large";
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(608),
        agentName: "custom-profile-agent",
        content: customProfile,
      }),
    ]).agentExecutionPlans.runnerProfilePolicyDifferences.count,
    1,
  );

  const alternateInstructionMarker = mutableAgentContent(
    "instruction-marker-agent",
  );
  alternateInstructionMarker.agents["instruction-marker-agent"]!.instructions =
    "AGENTS.md";
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(609),
        agentName: "instruction-marker-agent",
        content: alternateInstructionMarker,
      }),
    ]).status,
    "passed",
  );
  const missingInstructions = mutableAgentContent("missing-instructions-agent");
  delete missingInstructions.agents["missing-instructions-agent"]!.instructions;
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(610),
        agentName: "missing-instructions-agent",
        content: missingInstructions,
      }),
    ]).agentExecutionPlans.agentInstructionsMarkerOrMountDifferences.count,
    1,
  );

  const artifact = mutableAgentContent("artifact-agent");
  artifact.artifacts = [{ name: "legacy-artifact" }];
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(611),
        agentName: "artifact-agent",
        content: artifact,
      }),
    ]).agentExecutionPlans.composeArtifactOrVolumeDifferences.count,
    1,
  );
  const volume = mutableAgentContent("volume-agent");
  volume.agents["volume-agent"]!.volumes = ["legacy-volume:/data"];
  volume.volumes = {
    "legacy-volume": { name: "legacy-storage", version: "latest" },
  };
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(612),
        agentName: "volume-agent",
        content: volume,
      }),
    ]).agentExecutionPlans.composeArtifactOrVolumeDifferences.count,
    1,
  );
  const unreferencedVolume = mutableAgentContent("unreferenced-volume-agent");
  unreferencedVolume.volumes = {
    unused: { name: "legacy-storage", version: "latest" },
  };
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(613),
        agentName: "unreferenced-volume-agent",
        content: unreferencedVolume,
      }),
    ]).status,
    "passed",
  );
  const invalidVolume = mutableAgentContent("invalid-volume-agent");
  invalidVolume.agents["invalid-volume-agent"]!.volumes = [
    "missing-volume:/data",
  ];
  assert.equal(
    classifyPlanRows([
      executionPlanRow({
        id: id(614),
        agentName: "invalid-volume-agent",
        content: invalidVolume,
      }),
    ]).agentExecutionPlans.unsupportedOrInvalidContent.count,
    1,
  );

  const unknown = mutableAgentContent("unknown-agent");
  unknown.futureField = { payload: "never-emit-unknown-payload" };
  const unknownResult = classifyPlanRows([
    executionPlanRow({
      id: id(615),
      agentName: "unknown-agent",
      content: unknown,
    }),
  ]);
  assert.equal(unknownResult.agentExecutionPlans.unclassifiedContent.count, 1);
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(615),
        agentName: "unknown-agent",
        content: unknown,
      }),
    ).classification,
    "unclassifiedContent",
  );

  const dangling = classifyPlanRows([
    executionPlanRow({
      id: id(616),
      agentName: "dangling-plan-agent",
      content: null,
      headVersionId: "a".repeat(64),
      versionId: null,
    }),
  ]);
  assert.equal(
    dangling.agentExecutionPlans.danglingOrMissingHeadVersion.count,
    1,
  );
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(616),
        agentName: "dangling-plan-agent",
        content: null,
        headVersionId: "a".repeat(64),
        versionId: null,
      }),
    ).classification,
    "danglingOrMissingHeadVersion",
  );
  const absent = classifyPlanRows([], [id(617)]);
  assert.equal(
    absent.agentExecutionPlans.danglingOrMissingHeadVersion.count,
    1,
  );
  assert.equal(
    absent.agentExecutionPlans.inventoryClosure.classification,
    "drift",
  );

  const unsupported = executionPlanRow({
    id: id(618),
    agentName: "unsupported-agent",
    content: { version: "1", agents: {} },
  });
  const hashMismatch = executionPlanRow({
    id: id(619),
    agentName: "hash-mismatch-agent",
    headVersionId: "e".repeat(64),
    versionId: "e".repeat(64),
  });
  const invalid = executionPlanRow({
    id: id(620),
    agentName: "invalid-agent",
    content: "raw-invalid-payload",
  });
  const invalidResult = classifyPlanRows([unsupported, hashMismatch, invalid]);
  assert.equal(
    invalidResult.agentExecutionPlans.unsupportedOrInvalidContent.count,
    3,
  );

  const crossProvenance = executionPlanRow({
    id: id(621),
    agentName: "cross-provenance-agent",
    insertionComposeId: id(999),
  });
  assert.equal(classifyPlanRows([crossProvenance]).status, "passed");
  const crossNameContent = mutableAgentContent("other-agent-name");
  const crossName = classifyPlanRows([
    executionPlanRow({
      id: id(622),
      agentName: "product-agent-name",
      content: crossNameContent,
      insertionComposeId: id(998),
    }),
  ]);
  assert.equal(
    crossName.agentExecutionPlans.otherLaunchAffectingLegacyFields.count,
    1,
  );
  assert.equal(
    crossName.agentExecutionPlans.agentInstructionsMarkerOrMountDifferences
      .count,
    1,
  );
  assert.equal(crossName.agentExecutionPlans.multiDimensionExceptions.count, 1);

  const combined = mutableAgentContent("combined-agent");
  const combinedAgent = combined.agents["combined-agent"]!;
  combinedAgent.framework = "codex";
  combinedAgent.environment = { CUSTOM_VALUE: "combined-sensitive-value" };
  combinedAgent.experimental_runner = { group: "vm0/custom" };
  combinedAgent.experimental_profile = "vm0/large";
  delete combinedAgent.instructions;
  combined.artifacts = [{ name: "combined-artifact" }];
  const combinedResult = classifyPlanRows([
    executionPlanRow({
      id: id(623),
      agentName: "combined-agent",
      content: combined,
    }),
  ]);
  assert.equal(combinedResult.agentExecutionPlans.exceptions.count, 1);
  assert.equal(
    combinedResult.agentExecutionPlans.multiDimensionExceptions.count,
    1,
  );
  assert.equal(
    classifyAgentExecutionAuthority(
      executionPlanRow({
        id: id(623),
        agentName: "combined-agent",
        content: combined,
      }),
    ).classification,
    "multipleDimensions",
  );
  assert.equal(
    combinedResult.agentExecutionPlans.dimensionUnionClosure.classification,
    "exact",
  );

  const orderedRows = [
    executionPlanRow({ id: id(624), agentName: "order-one" }),
    executionPlanRow({ id: id(625), agentName: "order-two" }),
  ];
  assert.deepEqual(
    classifyPlanRows([...orderedRows].reverse()),
    classifyPlanRows(orderedRows),
  );
  const duplicate = classifyPlanRows([orderedRows[0]!, orderedRows[0]!]);
  assert.equal(
    duplicate.agentExecutionPlans.inventoryClosure.classification,
    "drift",
  );
  assert.equal(duplicate.agentExecutionPlans.unclassifiedContent.count, 1);
  const duplicateIdentity = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [identityRow(id(626)), identityRow(id(626))],
      agentExecutionPlans: [
        executionPlanRow({ id: id(626), agentName: "duplicate-identity" }),
        executionPlanRow({ id: id(626), agentName: "duplicate-identity" }),
      ],
    }),
    classificationOptions(),
  );
  assert.equal(
    duplicateIdentity.agentExecutionPlans.inventoryClosure.classification,
    "drift",
  );
  assert.equal(
    duplicateIdentity.agentExecutionPlans.partitionClosure.classification,
    "drift",
  );
  assert.equal(
    duplicateIdentity.agentExecutionPlans.dimensionUnionClosure.classification,
    "drift",
  );
  gatePresent(duplicate, "agentExecutionPlans.activity.partitionClosure");
}

/** Transition-only #28056 test fixture; removed by #26938 Stage 8. */
function historicalCandidate(
  agentName: string,
  content: unknown = buildHistoricalProductBuilderContent(
    "zero-connector-catalog-at-3b45e4e",
    agentName,
  ),
): HistoricalProductBuilderCandidate {
  const versionId =
    content !== null && typeof content === "object" && !Array.isArray(content)
      ? computeComposeVersionId(content as Record<string, unknown>)
      : "f".repeat(64);
  return { agentName, headVersionId: versionId, versionId, content };
}

/** Transition-only #28056 test fixture; removed by #26938 Stage 8. */
function mutableHistoricalContent(agentName: string): {
  readonly content: MutableAgentContent;
  readonly agent: MutableAgentDefinition;
  readonly environment: Record<string, string>;
} {
  const content = structuredClone(
    buildHistoricalProductBuilderContent(
      "zero-connector-catalog-at-3b45e4e",
      agentName,
    ),
  ) as MutableAgentContent;
  const agent = content.agents[agentName];
  assert.ok(agent);
  const environment = agent.environment;
  assert.ok(environment);
  return { content, agent, environment };
}

/** Transition-only #28056 and #28070 focused test; removed by #26938 Stage 8. */
function testHistoricalProductBuilderVariantAndClassifier(): void {
  assert.equal(HISTORICAL_PRODUCT_BUILDER_VARIANTS.length, 1);
  const variant = HISTORICAL_PRODUCT_BUILDER_VARIANTS[0];
  assert.ok(variant);
  assert.deepEqual(variant, {
    id: "zero-connector-catalog-at-3b45e4e",
    identityBranding: "zero",
    sourceCommit: "3b45e4eab8f1ca26f7187800c6e475b198ec0f28",
    sourcePullRequest: 14831,
    removalCommit: "68a48441b4c05ccd25d9599dd2b4e7be808aa450",
    removalPullRequest: 14820,
    eligibleConnectorCount: 229,
    environmentBindingCount: 281,
    variableBindingCount: 34,
    secretBindingCount: 247,
    reviewFingerprint:
      "26b88c167bd412c090e532c3d01a4c7ec03bd59465a60b78e27675f3c55ac959",
  });
  assert.equal(
    computeHistoricalProductBuilderReviewFingerprint(variant),
    variant.reviewFingerprint,
  );

  const reviewContent = buildHistoricalProductBuilderContent(
    variant.id,
    "historical-product-builder-review-agent",
  );
  assert.equal(
    computeComposeVersionId(reviewContent),
    "68b228b4d1c92baed368d360cc14379d9d9d46bb0d70d14ce4baa28505f579f7",
  );
  const reviewAgents = reviewContent.agents;
  assert.ok(isUnknownRecord(reviewAgents));
  const reviewAgent = reviewAgents["historical-product-builder-review-agent"];
  assert.ok(isUnknownRecord(reviewAgent));
  const reviewEnvironment = reviewAgent.environment;
  assert.ok(isUnknownRecord(reviewEnvironment));
  const entries = Object.entries(reviewEnvironment);
  assert.equal(entries.length, variant.environmentBindingCount);
  assert.equal(
    entries.filter(([, value]) => {
      return typeof value === "string" && value.startsWith("${{ vars.");
    }).length,
    variant.variableBindingCount,
  );
  assert.equal(
    entries.filter(([, value]) => {
      return typeof value === "string" && value.startsWith("${{ secrets.");
    }).length,
    variant.secretBindingCount,
  );
  for (const [key, value] of entries) {
    assert.ok(
      value === `\${{ vars.${key} }}` || value === `\${{ secrets.${key} }}`,
    );
  }

  const agentName = "historical-exact-agent";
  const exact = historicalCandidate(agentName);
  const unchanged = structuredClone(exact);
  assert.equal(isExactHistoricalProductBuilderCandidate(exact), true);
  assert.deepEqual(classifyAgentExecutionAuthority(exact), {
    authority: "application",
    classification: "applicationHistoricalProductBuilderEnvironment",
    dimensions: [],
  });
  assert.deepEqual(exact, unchanged);

  const changedKey = mutableHistoricalContent(agentName);
  const changedKeyValue = changedKey.environment.GH_TOKEN;
  assert.ok(changedKeyValue);
  delete changedKey.environment.GH_TOKEN;
  changedKey.environment.GH_TOKEN_CHANGED = changedKeyValue;

  const changedReference = mutableHistoricalContent(agentName);
  changedReference.environment.GH_TOKEN = "${{ secrets.OTHER_TOKEN }}";

  const sourceSwap = mutableHistoricalContent(agentName);
  sourceSwap.environment.ZERO_AGENT_ID = "${{ secrets.ZERO_AGENT_ID }}";

  const missingKey = mutableHistoricalContent(agentName);
  delete missingKey.environment.GH_TOKEN;

  const extraKey = mutableHistoricalContent(agentName);
  extraKey.environment.EXTRA_TOKEN = "${{ secrets.EXTRA_TOKEN }}";

  const partial = mutableHistoricalContent(agentName);
  partial.agent.environment = {
    GH_TOKEN: "${{ secrets.GH_TOKEN }}",
    ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
    ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
  };

  const merged = mutableHistoricalContent(agentName);
  merged.environment.OKOU_AGENT_ID = "${{ vars.OKOU_AGENT_ID }}";
  merged.environment.OKOU_TOKEN = "${{ secrets.OKOU_TOKEN }}";

  const literal = mutableHistoricalContent(agentName);
  literal.environment.GH_TOKEN = "literal-value";

  const unknownField = mutableHistoricalContent(agentName);
  unknownField.agent.futureField = true;

  const residualRuntimeField = mutableHistoricalContent(agentName);
  residualRuntimeField.agent.firewalls = { default: "allow" };

  const framework = mutableHistoricalContent(agentName);
  framework.agent.framework = "codex";

  const instructions = mutableHistoricalContent(agentName);
  instructions.agent.instructions = "AGENTS.md";

  const runner = mutableHistoricalContent(agentName);
  runner.agent.experimental_runner = { group: "vm0/custom" };

  const profile = mutableHistoricalContent(agentName);
  profile.agent.experimental_profile = "vm0/large";

  const storage = mutableHistoricalContent(agentName);
  storage.content.volumes = {
    data: { name: "historical-storage", version: "v1" },
  };
  storage.agent.volumes = ["data:/data"];

  const artifact = mutableHistoricalContent(agentName);
  artifact.content.artifacts = [{ name: "historical-artifact" }];

  const otherPlan = mutableHistoricalContent(agentName);
  otherPlan.agent.description = "historical-description";

  const ambiguous = mutableHistoricalContent(agentName);
  ambiguous.content.agents["second-agent"] = structuredClone(ambiguous.agent);

  const arbitrarySelfReference = mutableHistoricalContent(agentName);
  arbitrarySelfReference.agent.environment = {
    ARBITRARY_TOKEN: "${{ secrets.ARBITRARY_TOKEN }}",
  };

  const okouSubstitution = mutableHistoricalContent(agentName);
  delete okouSubstitution.environment.ZERO_AGENT_ID;
  delete okouSubstitution.environment.ZERO_TOKEN;
  okouSubstitution.environment.OKOU_AGENT_ID = "${{ vars.OKOU_AGENT_ID }}";
  okouSubstitution.environment.OKOU_TOKEN = "${{ secrets.OKOU_TOKEN }}";

  const mismatchedName = historicalCandidate(
    "different-product-agent",
    exact.content,
  );
  const hashDrift = {
    ...exact,
    versionId: "0".repeat(64),
    headVersionId: "0".repeat(64),
  };
  const headDrift = { ...exact, headVersionId: "1".repeat(64) };
  const danglingHead = { ...exact, headVersionId: null };
  const missingVersion = { ...exact, versionId: null };

  const unproven = [
    changedKey,
    changedReference,
    sourceSwap,
    missingKey,
    extraKey,
    partial,
    merged,
    literal,
    unknownField,
    residualRuntimeField,
    framework,
    instructions,
    runner,
    profile,
    storage,
    artifact,
    otherPlan,
    ambiguous,
    arbitrarySelfReference,
    okouSubstitution,
  ].map(({ content }) => {
    return historicalCandidate(agentName, content);
  });
  unproven.push(
    mismatchedName,
    hashDrift,
    headDrift,
    danglingHead,
    missingVersion,
    historicalCandidate(agentName, null),
  );
  for (const [index, candidate] of unproven.entries()) {
    const unchangedCandidate = structuredClone(candidate);
    assert.equal(isExactHistoricalProductBuilderCandidate(candidate), false);
    const authorityDecision = classifyAgentExecutionAuthority(candidate);
    assert.equal(
      authorityDecision.authority,
      "version_content",
      `unproven candidate ${index}: ${authorityDecision.classification}`,
    );
    assert.deepEqual(candidate, unchangedCandidate);
  }
}

/** Transition-only #28056 and #28070 focused test; removed by #26938 Stage 8. */
function testHistoricalProductBuilderOriginPartition(): void {
  const snapshot = new Date("2026-08-17T00:00:00.000Z");
  const id = (suffix: number): string => {
    return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  };
  const exactIds: string[] = [];
  const legacyEnvironmentRows: AgentExecutionPlanInventoryRow[] = [];
  for (let index = 0; index < 8; index += 1) {
    const exactId = id(800 + index);
    const exactName = `historical-origin-exact-${index}`;
    exactIds.push(exactId);
    legacyEnvironmentRows.push(
      executionPlanRow({
        id: exactId,
        agentName: exactName,
        content: buildHistoricalProductBuilderContent(
          "zero-connector-catalog-at-3b45e4e",
          exactName,
        ),
        activitySnapshotTime: snapshot,
        latestAttributedRunAt:
          index < 6 ? new Date("2026-06-15T00:00:00.000Z") : null,
        currentHeadEverExercised: index < 5,
      }),
    );
  }
  const referenceIds: string[] = [];
  for (let index = 0; index < 650; index += 1) {
    const rowId = id(808 + index);
    const name = `historical-origin-reference-${index}`;
    const content = mutableAgentContent(name);
    content.agents[name]!.environment = {
      [`LEGACY_CONNECTOR_${index}`]: `\${{ secrets.LEGACY_CONNECTOR_${index} }}`,
    };
    referenceIds.push(rowId);
    legacyEnvironmentRows.push(
      executionPlanRow({ id: rowId, agentName: name, content }),
    );
  }
  const literalId = id(1458);
  const literalName = "historical-origin-literal";
  const literalContent = mutableAgentContent(literalName);
  literalContent.agents[literalName]!.environment = {
    LEGACY_LITERAL: "literal-value",
  };
  legacyEnvironmentRows.push(
    executionPlanRow({
      id: literalId,
      agentName: literalName,
      content: literalContent,
      activitySnapshotTime: snapshot,
      latestAttributedRunAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  );

  const unclassifiedIds: string[] = [];
  const unclassifiedRows: AgentExecutionPlanInventoryRow[] = [];
  for (let index = 0; index < 167; index += 1) {
    const rowId = id(1459 + index);
    const name = `residual-content-${index}`;
    const content = mutableAgentContent(name);
    content.futureField = { reviewedRuntimeReachable: index };
    unclassifiedIds.push(rowId);
    unclassifiedRows.push(
      executionPlanRow({ id: rowId, agentName: name, content }),
    );
  }
  const unsupportedIds: string[] = [];
  const unsupportedRows: AgentExecutionPlanInventoryRow[] = [];
  for (let index = 0; index < 70; index += 1) {
    const rowId = id(1626 + index);
    unsupportedIds.push(rowId);
    unsupportedRows.push(
      executionPlanRow({
        id: rowId,
        agentName: `unsupported-content-${index}`,
        content: { version: "1", agents: {} },
      }),
    );
  }
  const danglingIds: string[] = [];
  const danglingRows: AgentExecutionPlanInventoryRow[] = [];
  for (let index = 0; index < 17; index += 1) {
    const rowId = id(1696 + index);
    danglingIds.push(rowId);
    danglingRows.push(
      executionPlanRow({
        id: rowId,
        agentName: `dangling-head-${index}`,
        content: null,
        headVersionId: "a".repeat(64),
        versionId: null,
      }),
    );
  }
  const rows = [
    ...legacyEnvironmentRows,
    ...unclassifiedRows,
    ...unsupportedRows,
    ...danglingRows,
  ];

  const result = classifyPlanRows(rows);
  const environment =
    result.agentExecutionPlans.refinements.systemEnvironmentDifferences;
  const origin = environment.historicalProductBuilderOrigin;
  assert.equal(
    result.agentExecutionPlans.systemEnvironmentDifferences.count,
    651,
  );
  assert.equal(
    result.agentExecutionPlans.systemEnvironmentDifferences.digest,
    fingerprintSortedSet(
      "agent-execution-plans:v6:residual-system-environment-differences:agent-ids",
      [...referenceIds, literalId],
    ).digest,
  );
  assert.equal(
    result.agentExecutionPlans.applicationHistoricalProductBuilderEnvironment
      .count,
    8,
  );
  assert.equal(
    result.agentExecutionPlans.applicationHistoricalProductBuilderEnvironment
      .digest,
    fingerprintSortedSet(
      "agent-execution-plans:v6:application-historical-product-builder-environment-agent-ids",
      exactIds,
    ).digest,
  );
  assert.equal(result.agentExecutionPlans.exceptions.count, 905);
  assert.equal(result.agentExecutionPlans.unclassifiedContent.count, 167);
  assert.equal(
    result.agentExecutionPlans.unclassifiedContent.digest,
    fingerprintSortedSet(
      "agent-execution-plans:unclassifiedContent:agent-ids",
      unclassifiedIds,
    ).digest,
  );
  assert.equal(
    result.agentExecutionPlans.unsupportedOrInvalidContent.count,
    70,
  );
  assert.equal(
    result.agentExecutionPlans.unsupportedOrInvalidContent.digest,
    fingerprintSortedSet(
      "agent-execution-plans:unsupportedOrInvalidContent:agent-ids",
      unsupportedIds,
    ).digest,
  );
  assert.equal(
    result.agentExecutionPlans.danglingOrMissingHeadVersion.count,
    17,
  );
  assert.equal(
    result.agentExecutionPlans.danglingOrMissingHeadVersion.digest,
    fingerprintSortedSet(
      "agent-execution-plans:danglingOrMissingHeadVersion:agent-ids",
      danglingIds,
    ).digest,
  );
  assert.equal(origin.legacyEnvironmentLineage.count, 659);
  assert.equal(
    origin.legacyEnvironmentLineage.digest,
    fingerprintSortedSet(
      "agent-execution-plans:systemEnvironmentDifferences:agent-ids",
      legacyEnvironmentRows.map((row) => {
        return row.id;
      }),
    ).digest,
  );
  assert.equal(origin.primary.exactHistoricalProductBuilder.count, 8);
  assert.equal(origin.primary.referenceOnlyButUnproven.count, 650);
  assert.equal(origin.primary.literalOrOtherUnproven.count, 1);
  assert.equal(origin.primaryPartitionClosure.classification, "exact");
  assert.equal(origin.primaryPartitionClosure.expected.count, 659);
  assert.equal(origin.primaryPartitionClosure.observed.count, 659);
  assert.equal(origin.primaryDisjointnessClosure.classification, "exact");
  assert.equal(origin.primaryDisjointnessClosure.observed.count, 0);
  assert.equal(origin.primaryUnionClosure.classification, "exact");
  assert.equal(origin.primaryUnionClosure.expected.count, 659);
  assert.equal(origin.primaryUnionClosure.observed.count, 659);
  assert.equal(
    origin.primary.exactHistoricalProductBuilder.digest,
    fingerprintSortedSet(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:primary:exactHistoricalProductBuilder:agent-ids",
      exactIds,
    ).digest,
  );
  assert.equal(
    origin.primary.referenceOnlyButUnproven.digest,
    fingerprintSortedSet(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:primary:referenceOnlyButUnproven:agent-ids",
      referenceIds,
    ).digest,
  );
  assert.equal(
    origin.primary.literalOrOtherUnproven.digest,
    fingerprintSortedSet(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin:primary:literalOrOtherUnproven:agent-ids",
      [literalId],
    ).digest,
  );
  const exactActivity = origin.activity.primary.exactHistoricalProductBuilder;
  const referenceActivity = origin.activity.primary.referenceOnlyButUnproven;
  const literalActivity = origin.activity.primary.literalOrOtherUnproven;
  assert.ok(exactActivity);
  assert.ok(referenceActivity);
  assert.ok(literalActivity);
  assert.equal(exactActivity.currentHeadEverExercised.count, 5);
  assert.equal(exactActivity.latestAttributedRun.over30Through90Days.count, 6);
  assert.equal(exactActivity.latestAttributedRun.noAttributedRun.count, 2);
  assert.equal(
    referenceActivity.latestAttributedRun.noAttributedRun.count,
    650,
  );
  assert.equal(literalActivity.latestAttributedRun.over90Days.count, 1);
  assert.equal(
    origin.applicationAuthorityMembershipLineageClosure.classification,
    "exact",
  );
  assert.equal(
    origin.residualEnvironmentMembershipLineageClosure.classification,
    "exact",
  );
  assert.equal(origin.authorityPartitionClosure.classification, "exact");
  assert.equal(origin.authorityPartitionClosure.expected.count, 659);
  assert.equal(origin.authorityPartitionClosure.observed.count, 659);
  assert.equal(origin.authorityDisjointnessClosure.classification, "exact");
  assert.equal(origin.authorityDisjointnessClosure.observed.count, 0);

  const duplicateFailureGates = new Set<string>();
  const duplicate = classifyExceptionRefinements({
    rowsById: new Map([[exactIds[0]!, [legacyEnvironmentRows[0]!]]]),
    legacyEnvironmentIds: [exactIds[0]!, exactIds[0]!],
    residualEnvironmentIds: [],
    applicationHistoricalProductBuilderEnvironmentIds: [exactIds[0]!],
    unsupportedIds: [],
    unclassifiedIds: [],
    failureGates: duplicateFailureGates,
  }).systemEnvironmentDifferences.historicalProductBuilderOrigin;
  assert.equal(duplicate.primaryPartitionClosure.classification, "drift");
  assert.equal(duplicate.primaryDisjointnessClosure.classification, "drift");
  assert.equal(duplicate.primaryUnionClosure.classification, "exact");
  assert.ok(
    duplicateFailureGates.has(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin.primaryPartitionClosure",
    ),
  );
  assert.ok(
    duplicateFailureGates.has(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.historicalProductBuilderOrigin.primaryDisjointnessClosure",
    ),
  );
}

function testEnvironmentExceptionRefinements(): void {
  const id = (suffix: number): string => {
    return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  };
  const environmentRow = (
    suffix: number,
    name: string,
    environment: Record<string, string>,
  ): AgentExecutionPlanInventoryRow => {
    const content = mutableAgentContent(name);
    content.agents[name]!.environment = environment;
    return executionPlanRow({ id: id(suffix), agentName: name, content });
  };
  const rows = [
    environmentRow(701, "variable-only-agent", {
      ANTHROPIC_API_KEY: "${{ vars.PROVIDER_VALUE }}",
    }),
    environmentRow(702, "secret-only-agent", {
      CUSTOM_SECRET: "${{ secrets.SECRET_VALUE }}",
    }),
    environmentRow(703, "mixed-reference-agent", {
      FIRST_VALUE: "${{ vars.FIRST_VALUE }}",
      SECOND_VALUE: "${{ secrets.SECOND_VALUE }}",
    }),
    environmentRow(704, "literal-agent", {
      REFERENCE_VALUE: "${{ vars.REFERENCE_VALUE }}",
      LITERAL_VALUE: "literal-${{ vars.LITERAL_VALUE }}",
    }),
    environmentRow(705, "malformed-agent", {
      UNSUPPORTED_VALUE: "${{ env.UNSUPPORTED_VALUE }}",
    }),
  ];
  const result = classifyPlanRows(rows);
  const refinement =
    result.agentExecutionPlans.refinements.systemEnvironmentDifferences;
  assert.equal(
    result.agentExecutionPlans.systemEnvironmentDifferences.count,
    5,
  );
  assert.equal(refinement.primary.variableReferenceOnly.count, 1);
  assert.equal(refinement.primary.secretReferenceOnly.count, 1);
  assert.equal(refinement.primary.mixedVariableSecretReferenceOnly.count, 1);
  assert.equal(refinement.primary.containsLiteralRuntimeValue.count, 1);
  assert.equal(refinement.primary.malformedOrUnsupportedTemplate.count, 1);
  assert.equal(refinement.primary.unclassifiedValueShape.count, 0);
  assert.equal(
    refinement.overlaps.officialModelProviderBindingCollision.count,
    1,
  );
  assert.equal(refinement.overlaps.multipleSurvivingLegacyEntries.count, 2);
  assert.equal(refinement.overlaps.mixedSourceOrValueSemantics.count, 3);
  assert.equal(refinement.primaryPartitionClosure.classification, "exact");
  assert.equal(refinement.primaryUnionClosure.classification, "exact");
  assert.equal(refinement.overlapUnionClosure.classification, "exact");
  assert.equal(
    refinement.historicalProductBuilderOrigin.primary
      .exactHistoricalProductBuilder.count,
    0,
  );
  assert.equal(
    refinement.historicalProductBuilderOrigin.primary.referenceOnlyButUnproven
      .count,
    3,
  );
  assert.equal(
    refinement.historicalProductBuilderOrigin.primary.literalOrOtherUnproven
      .count,
    2,
  );
  assert.equal(
    refinement.historicalProductBuilderOrigin.primaryPartitionClosure
      .classification,
    "exact",
  );
  assert.equal(
    refinement.historicalProductBuilderOrigin.primaryDisjointnessClosure
      .classification,
    "exact",
  );
  assert.equal(
    refinement.historicalProductBuilderOrigin.primaryUnionClosure
      .classification,
    "exact",
  );

  const unclassifiedId = id(706);
  const unclassifiedRow = executionPlanRow({
    id: unclassifiedId,
    agentName: "no-environment-agent",
  });
  const failureGates = new Set<string>();
  const forced = classifyExceptionRefinements({
    rowsById: new Map([[unclassifiedId, [unclassifiedRow]]]),
    legacyEnvironmentIds: [unclassifiedId],
    residualEnvironmentIds: [unclassifiedId],
    applicationHistoricalProductBuilderEnvironmentIds: [],
    unsupportedIds: [],
    unclassifiedIds: [],
    failureGates,
  });
  assert.equal(
    forced.systemEnvironmentDifferences.primary.unclassifiedValueShape.count,
    1,
  );
  assert.ok(
    failureGates.has(
      "agentExecutionPlans.refinements.systemEnvironmentDifferences.unclassifiedValueShape",
    ),
  );
}

function testUnsupportedExceptionRefinements(): void {
  const id = (suffix: number): string => {
    return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  };
  const hashPriority = mutableAgentContent("hash-priority-agent");
  (
    hashPriority.agents["hash-priority-agent"] as { framework: string }
  ).framework = "future-framework";
  const singular = {
    version: "1",
    agent: { framework: "claude-code" },
  };
  const missing = { version: "1", agents: {} };
  const framework = {
    version: "1",
    agents: { "framework-agent": { framework: "future-framework" } },
  };
  const environment = {
    version: "1",
    agents: {
      "invalid-environment-agent": {
        framework: "claude-code",
        environment: { INVALID_VALUE: 1 },
      },
    },
  };
  const volume = {
    version: "1",
    agents: {
      "invalid-volume-agent": {
        framework: "claude-code",
        volumes: ["missing-volume:/data"],
      },
    },
  };
  const other = {
    version: "",
    agents: { "other-invalid-agent": { framework: "claude-code" } },
  };
  const rows = [
    executionPlanRow({
      id: id(711),
      agentName: "hash-priority-agent",
      content: hashPriority,
      headVersionId: "e".repeat(64),
      versionId: "e".repeat(64),
    }),
    executionPlanRow({
      id: id(712),
      agentName: "non-object-agent",
      content: "invalid-content",
    }),
    executionPlanRow({
      id: id(713),
      agentName: "singular-agent",
      content: singular,
    }),
    executionPlanRow({
      id: id(714),
      agentName: "missing-agent",
      content: missing,
    }),
    executionPlanRow({
      id: id(715),
      agentName: "framework-agent",
      content: framework,
    }),
    executionPlanRow({
      id: id(716),
      agentName: "invalid-environment-agent",
      content: environment,
    }),
    executionPlanRow({
      id: id(717),
      agentName: "invalid-volume-agent",
      content: volume,
    }),
    executionPlanRow({
      id: id(718),
      agentName: "other-invalid-agent",
      content: other,
    }),
  ];
  const result = classifyPlanRows(rows);
  const refinement =
    result.agentExecutionPlans.refinements.unsupportedOrInvalidContent;
  assert.equal(result.agentExecutionPlans.unsupportedOrInvalidContent.count, 8);
  for (const reason of [
    "contentHashMismatch",
    "nonObjectNullOrArrayContent",
    "runtimeResolvableLegacySingularAgent",
    "missingOrAmbiguousActiveAgentDefinition",
    "unsupportedOrMissingFramework",
    "invalidEnvironmentContainerOrTemplateType",
    "invalidActiveVolumeOrArtifactShapeOrReference",
    "otherSchemaInvalidOrRuntimeUnresolvableContent",
  ] as const) {
    assert.equal(refinement.primary[reason].count, 1, reason);
  }
  assert.equal(refinement.primaryPartitionClosure.classification, "exact");
  assert.equal(refinement.primaryUnionClosure.classification, "exact");
}

function testUnclassifiedExceptionRefinements(): void {
  const id = (suffix: number): string => {
    return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  };
  const ignored = mutableAgentContent("ignored-nested-agent");
  ignored.volumes = {
    unused: { name: "ignored-storage", version: "latest" },
  };
  Object.assign(ignored.volumes.unused!, { futureField: "ignored-value" });

  const inactive = mutableAgentContent("selected-agent");
  inactive.agents["inactive-agent"] = {
    framework: "claude-code",
    futureField: "inactive-value",
  };

  const active = mutableAgentContent("active-extra-agent");
  active.agents["active-extra-agent"]!.futureField = "active-value";

  const activeStorage = mutableAgentContent("active-storage-agent");
  activeStorage.agents["active-storage-agent"]!.volumes = [
    "active-storage:/storage",
  ];
  activeStorage.volumes = {
    "active-storage": {
      name: "active-storage",
      version: "latest",
      system: true,
    },
  };

  const singularStorage = mutableAgentContent("plural-fallback-agent");
  Object.assign(singularStorage, {
    agent: {
      framework: "claude-code",
      volumes: ["singular-storage:/storage"],
    },
  });
  singularStorage.volumes = {
    "singular-storage": {
      name: "singular-storage",
      version: "latest",
      system: true,
    },
  };

  const inactiveStorage = mutableAgentContent("selected-storage-agent");
  inactiveStorage.agents["inactive-storage-agent"] = {
    framework: "claude-code",
    volumes: ["inactive-storage:/storage"],
  };
  inactiveStorage.volumes = {
    "inactive-storage": {
      name: "inactive-storage",
      version: "latest",
      system: true,
    },
  };

  const unreferencedStorage = mutableAgentContent("unreferenced-storage-agent");
  unreferencedStorage.volumes = {
    "unreferenced-storage": {
      name: "unreferenced-storage",
      version: "latest",
      system: true,
    },
  };

  const selectedAndInactiveStorage = mutableAgentContent(
    "selected-and-inactive-storage-agent",
  );
  selectedAndInactiveStorage.agents[
    "selected-and-inactive-storage-agent"
  ]!.volumes = ["shared-storage:/storage"];
  selectedAndInactiveStorage.agents["inactive-shared-storage-agent"] = {
    framework: "claude-code",
    volumes: ["shared-storage:/other-storage"],
  };
  selectedAndInactiveStorage.volumes = {
    "shared-storage": {
      name: "shared-storage",
      version: "latest",
      system: true,
    },
  };

  const mixedStorage = mutableAgentContent("mixed-storage-agent");
  mixedStorage.agents["mixed-storage-agent"]!.volumes = [
    "selected-mixed-storage:/storage",
  ];
  mixedStorage.volumes = {
    "selected-mixed-storage": {
      name: "selected-mixed-storage",
      version: "latest",
      system: true,
    },
    "unreferenced-mixed-storage": {
      name: "unreferenced-mixed-storage",
      version: "latest",
      system: true,
    },
  };

  const singularTopLevel = mutableAgentContent("plural-agent");
  Object.assign(singularTopLevel, {
    agent: { framework: "claude-code" },
  });

  const mixed = mutableAgentContent("mixed-selected-agent");
  mixed.agents["mixed-selected-agent"]!.futureField = "selected-value";
  mixed.agents["mixed-inactive-agent"] = {
    framework: "claude-code",
    futureField: "inactive-value",
  };

  const future = mutableAgentContent("future-agent");
  future.futureField = { payload: "unknown-future-value" };

  const recursivelyScanned = mutableAgentContent("recursive-agent");
  recursivelyScanned.futureField = {
    payload: "${{ secrets.STATUS_REFERENCE }}",
  };

  const assertSystemVolumeClass = (
    suffix: number,
    agentName: string,
    content: MutableAgentContent,
    expected: UnclassifiedPrimaryClass,
  ): void => {
    const single = classifyPlanRows([
      executionPlanRow({ id: id(suffix), agentName, content }),
    ]).agentExecutionPlans.refinements.unclassifiedContent;
    assert.equal(single.primary[expected].count, 1, expected);
    assert.equal(single.primaryPartitionClosure.classification, "exact");
  };
  assertSystemVolumeClass(
    728,
    "active-storage-agent",
    activeStorage,
    "activeAgentOrTopLevelRuntimeReachable",
  );
  assertSystemVolumeClass(
    729,
    "plural-fallback-agent",
    singularStorage,
    "activeAgentOrTopLevelRuntimeReachable",
  );
  assertSystemVolumeClass(
    730,
    "selected-storage-agent",
    inactiveStorage,
    "inactiveAgentOnly",
  );
  assertSystemVolumeClass(
    731,
    "unreferenced-storage-agent",
    unreferencedStorage,
    "runtimeIgnoredOnly",
  );
  assertSystemVolumeClass(
    732,
    "selected-and-inactive-storage-agent",
    selectedAndInactiveStorage,
    "activeAgentOrTopLevelRuntimeReachable",
  );
  assertSystemVolumeClass(
    733,
    "mixed-storage-agent",
    mixedStorage,
    "mixedLocations",
  );

  const result = classifyPlanRows([
    executionPlanRow({
      id: id(721),
      agentName: "ignored-nested-agent",
      content: ignored,
    }),
    executionPlanRow({
      id: id(722),
      agentName: "selected-agent",
      content: inactive,
    }),
    executionPlanRow({
      id: id(723),
      agentName: "active-extra-agent",
      content: active,
    }),
    executionPlanRow({
      id: id(724),
      agentName: "plural-agent",
      content: singularTopLevel,
    }),
    executionPlanRow({
      id: id(725),
      agentName: "mixed-selected-agent",
      content: mixed,
    }),
    executionPlanRow({
      id: id(726),
      agentName: "future-agent",
      content: future,
    }),
    executionPlanRow({
      id: id(727),
      agentName: "recursive-agent",
      content: recursivelyScanned,
    }),
    executionPlanRow({
      id: id(728),
      agentName: "active-storage-agent",
      content: activeStorage,
    }),
    executionPlanRow({
      id: id(729),
      agentName: "plural-fallback-agent",
      content: singularStorage,
    }),
    executionPlanRow({
      id: id(730),
      agentName: "selected-storage-agent",
      content: inactiveStorage,
    }),
    executionPlanRow({
      id: id(731),
      agentName: "unreferenced-storage-agent",
      content: unreferencedStorage,
    }),
    executionPlanRow({
      id: id(732),
      agentName: "selected-and-inactive-storage-agent",
      content: selectedAndInactiveStorage,
    }),
    executionPlanRow({
      id: id(733),
      agentName: "mixed-storage-agent",
      content: mixedStorage,
    }),
  ]);
  const refinement = result.agentExecutionPlans.refinements.unclassifiedContent;
  assert.equal(result.agentExecutionPlans.unclassifiedContent.count, 13);
  assert.equal(refinement.primary.runtimeIgnoredOnly.count, 2);
  assert.equal(refinement.primary.inactiveAgentOnly.count, 2);
  assert.equal(
    refinement.primary.activeAgentOrTopLevelRuntimeReachable.count,
    6,
  );
  assert.equal(refinement.primary.mixedLocations.count, 2);
  assert.equal(refinement.primary.stillUnknown.count, 1);
  assert.equal(refinement.primaryPartitionClosure.classification, "exact");
  assert.equal(refinement.primaryUnionClosure.classification, "exact");
}

function testExceptionActivityRefinementsAtSnapshot(snapshot: Date): void {
  const day = 24 * 60 * 60 * 1000;
  const id = (suffix: number): string => {
    return `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
  };
  const row = (
    suffix: number,
    age: number | null,
    flags: {
      readonly active?: boolean;
      readonly exercised?: boolean;
      readonly unknownStatus?: boolean;
    } = {},
  ): AgentExecutionPlanInventoryRow => {
    const name = `activity-agent-${suffix}`;
    const content = mutableAgentContent(name);
    content.agents[name]!.environment = {
      ACTIVITY_VALUE: "${{ vars.ACTIVITY_VALUE }}",
    };
    return executionPlanRow({
      id: id(suffix),
      agentName: name,
      content,
      activitySnapshotTime: snapshot,
      latestAttributedRunAt:
        age === null ? null : new Date(snapshot.getTime() - age),
      activeNonterminalRun: flags.active,
      currentHeadEverExercised: flags.exercised,
      unknownRunStatus: flags.unknownStatus,
    });
  };
  const result = classifyPlanRows([
    row(731, 7 * day, { active: true }),
    row(732, 30 * day, { exercised: true }),
    row(733, 90 * day),
    row(734, 91 * day),
    row(735, null),
  ]);
  const refinement =
    result.agentExecutionPlans.refinements.systemEnvironmentDifferences;
  const parent = refinement.activity.parent;
  assert.equal(parent.latestAttributedRun.within7Days.count, 1);
  assert.equal(parent.latestAttributedRun.over7Through30Days.count, 1);
  assert.equal(parent.latestAttributedRun.over30Through90Days.count, 1);
  assert.equal(parent.latestAttributedRun.over90Days.count, 1);
  assert.equal(parent.latestAttributedRun.noAttributedRun.count, 1);
  assert.equal(
    parent.latestAttributedRun.partitionClosure.classification,
    "exact",
  );
  assert.equal(parent.activeNonterminalRun.count, 1);
  assert.equal(parent.currentHeadEverExercised.count, 1);
  const primaryActivity = refinement.activity.primary.variableReferenceOnly;
  assert.ok(primaryActivity);
  assert.equal(primaryActivity.latestAttributedRun.within7Days.count, 1);
  assert.equal(primaryActivity.latestAttributedRun.over7Through30Days.count, 1);
  assert.equal(
    primaryActivity.latestAttributedRun.over30Through90Days.count,
    1,
  );
  assert.equal(primaryActivity.latestAttributedRun.over90Days.count, 1);
  assert.equal(primaryActivity.latestAttributedRun.noAttributedRun.count, 1);
  assert.equal(
    primaryActivity.latestAttributedRun.partitionClosure.classification,
    "exact",
  );

  const unknownStatus = classifyPlanRows([
    row(736, day, { unknownStatus: true }),
  ]);
  gatePresent(unknownStatus, "agentExecutionPlans.activity.unknownRunStatus");
  const future = classifyPlanRows([row(737, -1)]);
  gatePresent(future, "agentExecutionPlans.activity.partitionClosure");
}

function testExceptionActivityRefinements(): void {
  for (const timeZone of ACTIVITY_TIME_ZONES) {
    const snapshot =
      timeZone === "UTC"
        ? new Date("2026-08-17T00:00:00.000Z")
        : new Date("2026-08-17T00:00:00.000+08:00");
    testExceptionActivityRefinementsAtSnapshot(snapshot);
  }
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

  for (const kind of ["discovery", "reviewedConsumers"] as const) {
    const observedRuntimeContentConsumers = {
      ...EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST,
      [kind]: [
        ...EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST[kind],
        "unexpected-runtime-consumer",
      ],
    };
    const result = classifyPreflightInventory(capabilities, emptyInventory(), {
      ...classificationOptions(),
      observedRuntimeContentConsumers,
    });
    gatePresent(result, `agentExecutionPlans.runtimeConsumerManifest.${kind}`);
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
  const historicalId = "00000000-0000-4000-8000-000000000502";
  const historicalName = "historical-redaction-agent";
  const dangling = danglingRow({ composeId: rawId, name: rawName });
  const rawPlanContent = mutableAgentContent(rawName);
  rawPlanContent.agents[rawName]!.environment = {
    RAW_SECRET_KEY: "never-emit-environment-value",
  };
  const result = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [identityRow(rawId), identityRow(historicalId)],
      agentExecutionPlans: [
        executionPlanRow({
          id: rawId,
          agentName: rawName,
          content: rawPlanContent,
          latestAttributedRunAt: new Date("2026-08-16T12:34:56.000Z"),
        }),
        executionPlanRow({
          id: historicalId,
          agentName: historicalName,
          content: buildHistoricalProductBuilderContent(
            "zero-connector-catalog-at-3b45e4e",
            historicalName,
          ),
        }),
      ],
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
    "never-emit-environment-value",
    "RAW_SECRET_KEY",
    "2026-08-16T12:34:56.000Z",
    "2026-08-17T00:00:00.000Z",
    "OKOU_TOKEN",
    "ZERO_AGENT_ID",
    "GH_TOKEN",
    "${{ secrets.GH_TOKEN }}",
    "zero-connector-catalog-at-3b45e4e",
    "3b45e4eab8f1ca26f7187800c6e475b198ec0f28",
    "26b88c167bd412c090e532c3d01a4c7ec03bd59465a60b78e27675f3c55ac959",
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
    "agentExecutionPlans",
    "identity",
    "versions",
    "heads",
    "runs",
    "checkpoints",
    "danglingHeads",
    "dependencies",
    "launchSnapshots",
  ]);
  assert.deepEqual(outputPaths(result), [...PREFLIGHT_OUTPUT_ALLOWLIST]);
  assertSafeAggregateValues(result);

  const invalidOutput = {
    ...result,
    launchSnapshots: {
      ...result.launchSnapshots,
      unexpected: "never-emit-invalid-output-value",
    },
  };
  assert.throws(
    () => {
      assertPreflightOutputShape(invalidOutput);
    },
    (error: unknown) => {
      assert.ok(error instanceof SanitizedPreflightError);
      assert.deepEqual(sanitizedFailureResult(error), {
        schemaVersion: "vm0.agent-compose-consolidation-preflight.v6",
        status: "failed",
        failureGates: ["probe.output_shape"],
      });
      assert.equal(
        JSON.stringify(sanitizedFailureResult(error)).includes(
          "never-emit-invalid-output-value",
        ),
        false,
      );
      return true;
    },
  );
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
    "vm0.agent-compose-consolidation-preflight.v6",
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
  const observedRuntimeConsumers =
    await collectRuntimeContentConsumerManifest(repositoryRoot);
  assert.equal(
    runtimeContentConsumerManifestsEqual(
      EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST,
      observedRuntimeConsumers,
    ),
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

    const slackRouteDirectory = path.join(
      fixtureRoot,
      "turbo/apps/api/src/signals/routes",
    );
    await fs.mkdir(slackRouteDirectory, { recursive: true });
    const slackConsumerPath = path.join(
      slackRouteDirectory,
      "integrations-slack.ts",
    );
    const semanticConsumer = [
      "const selection = { content: agentComposeVersions.content };",
      "const version = { content: selection.content, other: selection.content };",
      "extractAndGroupVariables(version.content);",
      "",
    ].join("\n");
    await fs.writeFile(slackConsumerPath, semanticConsumer, "utf8");

    const runCreateDirectory = path.join(
      fixtureRoot,
      "turbo/apps/api/src/signals/services",
    );
    await fs.mkdir(runCreateDirectory, { recursive: true });
    const environmentShadowConsumerPath = path.join(
      runCreateDirectory,
      "agent-environment-shadow.ts",
    );
    const environmentShadowConsumer = [
      'const ENVIRONMENT_SHADOW_COUNT_BUCKETS = ["0", "1"] as const;',
      "interface ApplicationOwnedEnvironmentCandidateInput {",
      "  readonly runtimeOverrides: Readonly<Record<string, string>>;",
      "}",
      "function buildApplicationOwnedEnvironmentCandidate(",
      "  args: ApplicationOwnedEnvironmentCandidateInput,",
      ") {",
      "  void args;",
      "  return {};",
      "}",
      "function compareApplicationOwnedEnvironment() { return 'exact'; }",
      "",
    ].join("\n");
    await fs.writeFile(
      environmentShadowConsumerPath,
      environmentShadowConsumer,
      "utf8",
    );
    const runCreateConsumerPath = path.join(
      runCreateDirectory,
      "agent-run-create.service.ts",
    );
    const rawStorageForwarding = [
      "interface AgentComposeContent { readonly agents?: unknown }",
      "function buildRunnerJobPayload() {",
      "  return prepareAgentRunStorage({ content: args.resolved.content });",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(runCreateConsumerPath, rawStorageForwarding, "utf8");

    const storageConsumerPath = path.join(
      runCreateDirectory,
      "agent-run-storage.service.ts",
    );
    const systemVolumeConsumer = [
      "interface VolumeConfig { readonly system?: boolean }",
      "interface ResolvedVolume { readonly system?: boolean }",
      "interface AgentComposeContent { readonly volumes?: Record<string, VolumeConfig> }",
      "function firstAgentEntry(content: AgentComposeContent) { return content; }",
      "function resolveComposeVolumes() {",
      "  return { system: config.system };",
      "}",
      "function resolveVolumeStorage() {",
      "  if (args.volume.system) return SYSTEM_ORG_ID;",
      "}",
      "function resolveComposeStorageInput() { return resolveVolumeStorage(); }",
      "function storageManifestRequests() {",
      "  if (volume.system) return SYSTEM_ORG_ID;",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(storageConsumerPath, systemVolumeConsumer, "utf8");

    const zeroRunConsumerPath = path.join(
      runCreateDirectory,
      "zero-runs-create.service.ts",
    );
    const zeroRunConsumer = [
      "interface ZeroAgentRunRecord {",
      "  readonly content: ZeroAgentComposeContent;",
      "}",
      "interface ZeroAgentComposeContent { readonly agents?: unknown }",
      "async function loadZeroAgent() {",
      "  const [agent] = await db",
      "    .select({ content: agentComposeVersions.content })",
      "    .from(zeroAgents)",
      "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
      "    .innerJoin(",
      "      agentComposeVersions,",
      "      eq(agentComposeVersions.id, agentComposes.headVersionId),",
      "    );",
      "  return agent",
      "    ? { content: agent.content as ZeroAgentComposeContent }",
      "    : null;",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(zeroRunConsumerPath, zeroRunConsumer, "utf8");

    const semanticBaseline =
      await collectRuntimeContentConsumerManifest(fixtureRoot);

    await fs.writeFile(
      environmentShadowConsumerPath,
      environmentShadowConsumer.replace(
        "  return {};",
        "  return firstAgent(args.content).environment;",
      ),
      "utf8",
    );
    const environmentShadowLegacyDrift =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(
        semanticBaseline,
        environmentShadowLegacyDrift,
      ),
      false,
    );
    await fs.writeFile(
      environmentShadowConsumerPath,
      environmentShadowConsumer,
      "utf8",
    );

    const unrelatedZeroRunQueryChange = zeroRunConsumer
      .replace(
        ".select({ content: agentComposeVersions.content })",
        ".select({ defaultAgentId: orgMetadata.defaultAgentId, content: agentComposeVersions.content })",
      )
      .replace(
        "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
        [
          "    .leftJoin(orgMetadata, eq(orgMetadata.orgId, zeroAgents.orgId))",
          "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
        ].join("\n"),
      );
    await fs.writeFile(
      zeroRunConsumerPath,
      unrelatedZeroRunQueryChange,
      "utf8",
    );
    const unrelatedZeroRunQuery =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(
        semanticBaseline,
        unrelatedZeroRunQuery,
      ),
      true,
    );
    await fs.writeFile(zeroRunConsumerPath, zeroRunConsumer, "utf8");

    const zeroRunSemanticDrifts = [
      zeroRunConsumer.replace(
        "eq(agentComposes.id, zeroAgents.id)",
        "eq(agentComposes.id, zeroAgents.otherId)",
      ),
      zeroRunConsumer.replace(
        "agentComposes.headVersionId",
        "agentComposes.otherVersionId",
      ),
      zeroRunConsumer.replace(
        "content: agentComposeVersions.content",
        "content: agentComposeVersions.otherContent",
      ),
      zeroRunConsumer.replace(
        "agent.content as ZeroAgentComposeContent",
        "agent.content as UnknownComposeContent",
      ),
      zeroRunConsumer.replace(
        "readonly content: ZeroAgentComposeContent",
        "readonly content: unknown",
      ),
      zeroRunConsumer.replace(
        "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
        "",
      ),
      zeroRunConsumer.replace(
        "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
        [
          "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
          "    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))",
        ].join("\n"),
      ),
      zeroRunConsumer.replace(
        "  return agent",
        [
          "  const duplicate = agent.content as ZeroAgentComposeContent;",
          "  void duplicate;",
          "  return agent",
        ].join("\n"),
      ),
      zeroRunConsumer.replace(
        "  return agent",
        ["  void agent.content;", "  return agent"].join("\n"),
      ),
    ];
    for (const driftedZeroRunConsumer of zeroRunSemanticDrifts) {
      assert.notEqual(driftedZeroRunConsumer, zeroRunConsumer);
      await fs.writeFile(zeroRunConsumerPath, driftedZeroRunConsumer, "utf8");
      const zeroRunSemanticDrift =
        await collectRuntimeContentConsumerManifest(fixtureRoot);
      assert.equal(
        runtimeContentConsumerManifestsEqual(
          semanticBaseline,
          zeroRunSemanticDrift,
        ),
        false,
      );
    }
    await fs.writeFile(zeroRunConsumerPath, zeroRunConsumer, "utf8");

    await fs.writeFile(
      runCreateConsumerPath,
      rawStorageForwarding.replace(
        "content: args.resolved.content",
        "content: args.parsed.content",
      ),
      "utf8",
    );
    const rawForwardingDrift =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(
        semanticBaseline,
        rawForwardingDrift,
      ),
      false,
    );
    await fs.writeFile(runCreateConsumerPath, rawStorageForwarding, "utf8");

    await fs.writeFile(
      storageConsumerPath,
      systemVolumeConsumer.replace("config.system", "config.optional"),
      "utf8",
    );
    const systemPropagationDrift =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(
        semanticBaseline,
        systemPropagationDrift,
      ),
      false,
    );
    await fs.writeFile(storageConsumerPath, systemVolumeConsumer, "utf8");

    await fs.writeFile(
      storageConsumerPath,
      systemVolumeConsumer.replace("volume.system", "volume.optional"),
      "utf8",
    );
    const systemPlanningDrift =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(
        semanticBaseline,
        systemPlanningDrift,
      ),
      false,
    );
    await fs.writeFile(storageConsumerPath, systemVolumeConsumer, "utf8");

    await fs.writeFile(
      slackConsumerPath,
      `${semanticConsumer}const unrelatedCardUrl = "https://example.invalid/card";\n`,
      "utf8",
    );
    const unrelatedChange =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(semanticBaseline, unrelatedChange),
      true,
    );
    await fs.writeFile(
      slackConsumerPath,
      semanticConsumer.replace(
        "extractAndGroupVariables(version.content)",
        "extractAndGroupVariables(version.other)",
      ),
      "utf8",
    );
    const semanticDrift =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.equal(
      runtimeContentConsumerManifestsEqual(semanticBaseline, semanticDrift),
      false,
    );
    await fs.writeFile(
      path.join(sourceDirectory, "unexpected-content-consumer.ts"),
      "interface AgentComposeContent { readonly future?: unknown }\n",
      "utf8",
    );
    const exhaustiveDrift =
      await collectRuntimeContentConsumerManifest(fixtureRoot);
    assert.ok(
      exhaustiveDrift.discovery.length > semanticDrift.discovery.length,
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
  assert.match(
    workflow,
    /#27613 \+ #27656 \+ #27671 \+ #27792 \+ #28056 \+ #28070/u,
  );
  assert.match(workflow, /vm0\.agent-compose-consolidation-preflight\.v6/u);
  assert.equal(
    /vm0\.agent-compose-consolidation-preflight\.v[1-5]/u.test(workflow),
    false,
  );
  assert.equal(
    /pull_request:|schedule:|actions\/upload-artifact/iu.test(workflow),
    false,
  );
  assert.equal(/--apply|fallback|REPORT_PATH/iu.test(workflow), false);

  const preflightSource = await fs.readFile(
    path.join(
      repositoryRoot,
      "turbo/packages/db/scripts/agent-compose-consolidation-preflight.ts",
    ),
    "utf8",
  );
  assert.match(
    preflightSource,
    /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u,
  );
  assert.match(preflightSource, /const DEFAULT_LOCK_TIMEOUT_MS = 1000;/u);
  assert.match(
    preflightSource,
    /const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;/u,
  );
  assert.equal(
    /\b(?:UPDATE|INSERT|DELETE|CREATE|ALTER|DROP|TRUNCATE|LOCK TABLE|pg_advisory_)\b/iu.test(
      preflightSource,
    ),
    false,
  );
  const inventoryStart = preflightSource.indexOf(
    "async function collectDatabaseInventory(",
  );
  const inventoryEnd = preflightSource.indexOf(
    "export async function executeAgentComposeConsolidationPreflight(",
  );
  assert.ok(inventoryStart >= 0 && inventoryEnd > inventoryStart);
  const inventorySource = preflightSource.slice(inventoryStart, inventoryEnd);
  assert.equal(inventorySource.match(/safeQuery</gu)?.length, 10);

  const historicalClassifierPath = path.join(
    repositoryRoot,
    "turbo/apps/api/src/signals/services/historical-product-builder.ts",
  );
  const historicalClassifierSource = await fs.readFile(
    historicalClassifierPath,
    "utf8",
  );
  assert.equal(historicalClassifierSource.includes('from "pg"'), false);
  assert.equal(historicalClassifierSource.includes("safeQuery"), false);
  assert.equal(
    historicalClassifierSource.includes("activitySnapshotTime"),
    false,
  );
  assert.equal(
    historicalClassifierSource.includes("latestAttributedRunAt"),
    false,
  );
  assert.equal(historicalClassifierSource.includes("createdAt"), false);
  assert.equal(
    /\b(?:SELECT\s+|UPDATE\s+\S+\s+SET\s+|INSERT\s+INTO\s+|DELETE\s+FROM\s+|CREATE\s+(?:TABLE|INDEX|VIEW)\s+|ALTER\s+TABLE\s+|DROP\s+(?:TABLE|INDEX|VIEW)\s+|TRUNCATE\s+)\b/iu.test(
      historicalClassifierSource,
    ),
    false,
  );
  const historicalClassifierCallers = execFileSync(
    "rg",
    [
      "-l",
      "-F",
      "isExactHistoricalProductBuilderCandidate(",
      "--glob",
      "*.ts",
      "turbo/apps/api/src/signals",
      "turbo/packages/db/scripts",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(historicalClassifierCallers, [
    "turbo/apps/api/src/signals/services/agent-execution-authority.ts",
    "turbo/apps/api/src/signals/services/historical-product-builder.ts",
    "turbo/packages/db/scripts/agent-compose-consolidation-preflight-refinements.ts",
    "turbo/packages/db/scripts/test-agent-compose-consolidation-preflight.ts",
  ]);

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
  const executionPlanOwner = await fs.readFile(
    path.join(
      repositoryRoot,
      "turbo/apps/api/src/signals/services/agent-execution-plan.ts",
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
  assert.equal(
    executionPlanOwner.match(/const APPLICATION_OWNED_AGENT_EXECUTION_PLAN/gu)
      ?.length,
    1,
  );
  assert.equal(executionPlanOwner.includes("agent-compose"), false);
  assert.equal(
    contentOwner.includes("APPLICATION_OWNED_AGENT_EXECUTION_PLAN"),
    true,
  );
}

async function testConnectionFailureIsSanitized(): Promise<void> {
  await assert.rejects(
    executeAgentComposeConsolidationPreflight({
      connectionString: "postgresql://127.0.0.1:1/preflight",
      repositoryRoot,
    }),
    (error: unknown) => {
      return (
        error instanceof SanitizedPreflightError &&
        error.gate === "probe.database_connection"
      );
    },
  );
}

function databaseUrlFor(baseUrl: URL, database: string): string {
  const result = new URL(baseUrl);
  result.pathname = `/${database}`;
  return result.toString();
}

function databaseUrlForTimeZone(
  baseUrl: URL,
  database: string,
  timeZone: (typeof ACTIVITY_TIME_ZONES)[number],
): string {
  const result = new URL(databaseUrlFor(baseUrl, database));
  result.searchParams.set("options", `-c TimeZone=${timeZone}`);
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

async function testDatabaseBoundariesForTimeZone(
  databaseUrl: string,
  timeZone: (typeof ACTIVITY_TIME_ZONES)[number],
): Promise<void> {
  const sourceUrl = new URL(databaseUrl);
  const admin = new Client({
    connectionString: databaseUrlFor(sourceUrl, "postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
  const testUrl = databaseUrlForTimeZone(sourceUrl, testDatabase, timeZone);

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
      const sessionTimeZone = await client.query<{ timeZone: string }>(
        `SELECT current_setting('TimeZone') AS "timeZone"`,
      );
      const writerTimeZone = await writer.query<{ timeZone: string }>(
        `SELECT current_setting('TimeZone') AS "timeZone"`,
      );
      assert.equal(sessionTimeZone.rows[0]?.timeZone, timeZone);
      assert.equal(writerTimeZone.rows[0]?.timeZone, timeZone);
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

      const cancellationClient = new Client({ connectionString: testUrl });
      await cancellationClient.connect();
      const abortController = new AbortController();
      let signalQueryStarted = (): void => {};
      const queryStarted = new Promise<void>((resolve) => {
        signalQueryStarted = resolve;
      });
      const cancelledQuery = withReadOnlySnapshot(
        cancellationClient,
        { signal: abortController.signal },
        async () => {
          signalQueryStarted();
          await cancellationClient.query("SELECT pg_sleep(30)");
        },
      );
      await queryStarted;
      abortController.abort();
      await assert.rejects(cancelledQuery, (error: unknown) => {
        return (
          error instanceof SanitizedPreflightError &&
          error.gate === "probe.cancelled"
        );
      });
      await cancellationClient.end().catch(() => {});

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
        const snapshotStart = await client.query<{ observedAt: Date }>(
          `SELECT transaction_timestamp() AS "observedAt"`,
        );
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
        const snapshotEnd = await client.query<{ observedAt: Date }>(
          `SELECT transaction_timestamp() AS "observedAt"`,
        );
        assert.deepEqual(end.rows, start.rows);
        assert.equal(start.rows[0]?.head, firstHead);
        assert.ok(snapshotStart.rows[0]?.observedAt instanceof Date);
        assert.ok(snapshotEnd.rows[0]?.observedAt instanceof Date);
        assert.equal(
          snapshotEnd.rows[0]?.observedAt.getTime(),
          snapshotStart.rows[0]?.observedAt.getTime(),
        );
      });
      const live = await client.query<{ head: string }>(
        `SELECT "head_version_id" AS "head" FROM "agent_composes"
         WHERE "id" = $1`,
        [concurrentAgentId],
      );
      assert.equal(live.rows[0]?.head, secondHead);

      const provenanceOwnerAgentId = "00000000-0000-4000-8000-000000027621";
      const exercisingAgentId = "00000000-0000-4000-8000-000000027622";
      const exercisingSessionId = "00000000-0000-4000-8000-000000027623";
      const exercisingRunId = "00000000-0000-4000-8000-000000027624";
      const sharedContent = mutableAgentContent("shared-activity-agent");
      sharedContent.agents["shared-activity-agent"]!.environment = {
        SHARED_ACTIVITY_VALUE: "${{ vars.SHARED_ACTIVITY_VALUE }}",
      };
      const sharedVersionId = computeComposeVersionId(sharedContent);
      await client.query(
        `INSERT INTO "agent_composes" (
           "id", "user_id", "name", "org_id"
         ) VALUES
           ($1, 'provenance-owner-user', 'shared-activity-agent', 'provenance-owner-org'),
           ($2, 'exercising-agent-user', 'shared-activity-agent', 'exercising-agent-org')`,
        [provenanceOwnerAgentId, exercisingAgentId],
      );
      await client.query(
        `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
         VALUES
           ($1, 'provenance-owner-org', 'provenance-owner-user', 'shared-activity-agent'),
           ($2, 'exercising-agent-org', 'exercising-agent-user', 'shared-activity-agent')`,
        [provenanceOwnerAgentId, exercisingAgentId],
      );
      await client.query(
        `INSERT INTO "agent_compose_versions" (
           "id", "compose_id", "content", "created_by"
         ) VALUES ($1, $2, $3::jsonb, 'provenance-owner-user')`,
        [sharedVersionId, provenanceOwnerAgentId, sharedContent],
      );
      await client.query(
        `UPDATE "agent_composes" SET "head_version_id" = $1
         WHERE "id" = ANY($2::uuid[])`,
        [sharedVersionId, [provenanceOwnerAgentId, exercisingAgentId]],
      );
      await client.query(
        `INSERT INTO "agent_sessions" (
           "id", "user_id", "org_id", "agent_compose_id"
         ) VALUES ($1, 'exercising-agent-user', 'exercising-agent-org', $2)`,
        [exercisingSessionId, exercisingAgentId],
      );
      await client.query(
        `INSERT INTO "agent_runs" (
           "id", "user_id", "org_id", "session_id", "status", "prompt",
           "agent_compose_version_id"
         ) VALUES (
           $1, 'exercising-agent-user', 'exercising-agent-org', $2,
           'running', 'session-owned activity fixture', $3
        )`,
        [exercisingRunId, exercisingSessionId, sharedVersionId],
      );
      const ownershipProbe = await client.query<{
        activeNonterminalRun: boolean;
        agentComposeId: string;
        activitySnapshotTime: Date;
        currentHeadEverExercised: boolean;
        latestAttributedRunAt: Date;
      }>(
        `SELECT
           "session"."agent_compose_id"::text AS "agentComposeId",
           max("run"."created_at") AT TIME ZONE current_setting('TimeZone')
             AS "latestAttributedRunAt",
           transaction_timestamp() AS "activitySnapshotTime",
           bool_or("run"."status" = 'running') AS "activeNonterminalRun",
           bool_or(
             "run"."agent_compose_version_id" = "compose"."head_version_id"
           ) AS "currentHeadEverExercised"
         FROM "agent_sessions" AS "session"
         INNER JOIN "agent_runs" AS "run"
           ON "run"."session_id" = "session"."id"
         INNER JOIN "agent_composes" AS "compose"
           ON "compose"."id" = "session"."agent_compose_id"
          AND "compose"."org_id" = "session"."org_id"
          AND "compose"."org_id" = "run"."org_id"
         WHERE "session"."id" = $1
         GROUP BY "session"."agent_compose_id"`,
        [exercisingSessionId],
      );
      const ownershipProbeRow = ownershipProbe.rows[0];
      assert.deepEqual(
        {
          activeNonterminalRun: ownershipProbeRow?.activeNonterminalRun,
          agentComposeMatch:
            ownershipProbeRow?.agentComposeId === exercisingAgentId,
          currentHeadEverExercised: ownershipProbeRow?.currentHeadEverExercised,
          latestAttributedRunAtIsDate:
            ownershipProbeRow?.latestAttributedRunAt instanceof Date,
          latestAttributedRunIsNotFuture:
            ownershipProbeRow?.latestAttributedRunAt instanceof Date &&
            ownershipProbeRow.activitySnapshotTime instanceof Date &&
            ownershipProbeRow.latestAttributedRunAt.getTime() <=
              ownershipProbeRow.activitySnapshotTime.getTime(),
          snapshotIsDate:
            ownershipProbeRow?.activitySnapshotTime instanceof Date,
          rowCount: ownershipProbe.rowCount,
        },
        {
          activeNonterminalRun: true,
          agentComposeMatch: true,
          currentHeadEverExercised: true,
          latestAttributedRunAtIsDate: true,
          latestAttributedRunIsNotFuture: true,
          snapshotIsDate: true,
          rowCount: 1,
        },
      );
      const attributed = await executeAgentComposeConsolidationPreflight({
        connectionString: testUrl,
        repositoryRoot,
        classification: {
          ...executionOptions,
          expectedDanglingHeadCount: 1,
        },
      });
      assert.equal(
        attributed.launchSnapshots.dispositions.historical_unknown.count,
        1,
      );
      assert.equal(
        attributed.launchSnapshots.dispositions.integrity_conflict.count,
        0,
      );
      assert.equal(
        attributed.launchSnapshots.reasons.framework_provider_missing.count,
        1,
      );
      const activity =
        attributed.agentExecutionPlans.refinements.systemEnvironmentDifferences
          .activity.parent;
      assert.equal(
        attributed.agentExecutionPlans.systemEnvironmentDifferences.count,
        2,
      );
      assert.equal(
        activity.latestAttributedRun.within7Days.count,
        1,
        JSON.stringify({
          within7Days: activity.latestAttributedRun.within7Days.count,
          over7Through30Days:
            activity.latestAttributedRun.over7Through30Days.count,
          over30Through90Days:
            activity.latestAttributedRun.over30Through90Days.count,
          over90Days: activity.latestAttributedRun.over90Days.count,
          noAttributedRun: activity.latestAttributedRun.noAttributedRun.count,
          activeNonterminalRun: activity.activeNonterminalRun.count,
          currentHeadEverExercised: activity.currentHeadEverExercised.count,
          partitionClosure:
            activity.latestAttributedRun.partitionClosure.classification,
        }),
      );
      assert.equal(activity.latestAttributedRun.noAttributedRun.count, 1);
      assert.equal(activity.activeNonterminalRun.count, 1);
      assert.equal(activity.currentHeadEverExercised.count, 1);
      assert.equal(
        activity.latestAttributedRun.partitionClosure.classification,
        "exact",
      );

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

async function testDatabaseBoundaries(databaseUrl: string): Promise<void> {
  for (const timeZone of ACTIVITY_TIME_ZONES) {
    await testDatabaseBoundariesForTimeZone(databaseUrl, timeZone);
  }
}

export async function validateAgentComposeConsolidationPreflightStatic(): Promise<void> {
  await validateLaunchSnapshotRecoverabilityStatic();
  await validateLaunchSnapshotBackfillStatic();
  testSchemaV3DomainsRemainByteStable();
  testSchemaV4OutputContractRemainsByteStable();
  testSchemaV5OutputContractRemainsByteStable();
  testApplicationOwnedPlanAndCanonicalCompatibility();
  testIdentityAndApprovedArtifacts();
  testVersionHeadRunAndCheckpointClassifications();
  testDanglingClassifications();
  testAgentExecutionPlanClassifications();
  testHistoricalProductBuilderVariantAndClassifier();
  testHistoricalProductBuilderOriginPartition();
  testEnvironmentExceptionRefinements();
  testUnsupportedExceptionRefinements();
  testUnclassifiedExceptionRefinements();
  testExceptionActivityRefinements();
  testDependencyDriftAndDeterminism();
  testOutputRedaction();
  await testRepositoryAndWorkflowValidators();
  await testConnectionFailureIsSanitized();
}

export async function validateAgentComposeConsolidationPreflight(): Promise<void> {
  await validateAgentComposeConsolidationPreflightStatic();

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await testDatabaseBoundaries(databaseUrl);
  await validateLaunchSnapshotBackfillDatabase(databaseUrl);
  console.log("agent compose consolidation preflight passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentComposeConsolidationPreflight().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
