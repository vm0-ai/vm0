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
  PREFLIGHT_OUTPUT_ALLOWLIST,
  SanitizedPreflightError,
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
    { name: string; version: string; optional?: boolean }
  >;
  artifacts?: { name: string; version?: string; mount_path?: string }[];
  futureField?: unknown;
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
  const rawPlanContent = mutableAgentContent(rawName);
  rawPlanContent.agents[rawName]!.environment = {
    RAW_SECRET_KEY: "never-emit-environment-value",
  };
  const result = classifyPreflightInventory(
    capabilities,
    emptyInventory({
      identity: [identityRow(rawId)],
      agentExecutionPlans: [
        executionPlanRow({
          id: rawId,
          agentName: rawName,
          content: rawPlanContent,
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
    "agentExecutionPlans",
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
    "vm0.agent-compose-consolidation-preflight.v2",
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
  assert.match(workflow, /#27613 \+ #27656/u);
  assert.match(workflow, /vm0\.agent-compose-consolidation-preflight\.v2/u);
  assert.equal(
    workflow.includes("vm0.agent-compose-consolidation-preflight.v1"),
    false,
  );
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
  testApplicationOwnedPlanAndCanonicalCompatibility();
  testIdentityAndApprovedArtifacts();
  testVersionHeadRunAndCheckpointClassifications();
  testDanglingClassifications();
  testAgentExecutionPlanClassifications();
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
