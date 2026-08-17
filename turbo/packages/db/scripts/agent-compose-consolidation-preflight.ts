#!/usr/bin/env tsx
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentComposeApiContentSchema } from "@okouai/api-contracts/contracts/composes";
import { ALL_RUN_STATUSES } from "@okouai/api-contracts/contracts/runs";
import { Client, type QueryResultRow } from "pg";
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
  type CatalogDependencyKind,
  type CatalogDependencyRow,
  type RepositoryDependencyManifest,
} from "./agent-compose-consolidation-preflight-manifest";
import {
  PREFLIGHT_SCHEMA_VERSION,
  fingerprintMember,
  fingerprintSortedSet,
  type SetFingerprint,
} from "./agent-compose-consolidation-preflight-fingerprint";
import {
  LAUNCH_SNAPSHOT_DISPOSITIONS,
  LAUNCH_SNAPSHOT_REASONS,
  classifyLaunchSnapshotRecoverability,
  type LaunchSnapshotCheckpointInventoryRow,
  type LaunchSnapshotConversationInventoryRow,
  type LaunchSnapshotRunInventoryRow,
} from "./agent-compose-consolidation-preflight-launch-snapshots";
import {
  EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST,
  collectRuntimeContentConsumerManifest,
  type RuntimeContentConsumerManifest,
} from "./agent-compose-consolidation-preflight-consumers";
import {
  ACTIVITY_BUCKETS,
  ENVIRONMENT_OVERLAP_DIMENSIONS,
  ENVIRONMENT_PRIMARY_CLASSES,
  UNCLASSIFIED_PRIMARY_CLASSES,
  UNSUPPORTED_PRIMARY_REASONS,
  classifyExceptionRefinements,
} from "./agent-compose-consolidation-preflight-refinements";

const MINIMUM_SERVER_VERSION = 170000;
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_EXPECTED_DANGLING_HEAD_COUNT = 17;
const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;

/** Safe digests of the six #26938-approved compose-only artifact IDs. */
export const APPROVED_ARTIFACT_MEMBER_DIGESTS = [
  "113ad6becc69859c5d32951a5f1a1f0fa4ba80c0d3db8844aa7d03917265220a",
  "8dfd7409ac22987095db85e8d847b68b79ba5dd10061699a2cd8b342f0aa5a53",
  "9697088dede8e0c6d34e043d4e9195cb7f02eed78d03c3b5eaeffaf699a6cdad",
  "96eb4f5d3c590dc9576ebb780be44742b08936936b8230c1b80cb7c52179ae94",
  "da7f6e8f1e287573ecf9e04e7ae2c1f2cb6605f694cfeae4dd748a9ad86ef934",
  "e7bf22154afdeb95446d7be90a79f75813073581a292c334807ea37dd8adc37a",
] as const;

export const APPROVED_ARTIFACT_SET_DIGEST =
  "a83a3c8751fa88778aca7ac93b7d595a7e4c8e9e79cb08c9696ed1dd9e943b5c";

/** Exact scalar/array paths permitted in a complete production result. */
const PREFLIGHT_V2_OUTPUT_ALLOWLIST = [
  "agentExecutionPlans.agentInstructionsMarkerOrMountDifferences.count",
  "agentExecutionPlans.agentInstructionsMarkerOrMountDifferences.digest",
  "agentExecutionPlans.completeSemanticParity.count",
  "agentExecutionPlans.completeSemanticParity.digest",
  "agentExecutionPlans.composeArtifactOrVolumeDifferences.count",
  "agentExecutionPlans.composeArtifactOrVolumeDifferences.digest",
  "agentExecutionPlans.danglingOrMissingHeadVersion.count",
  "agentExecutionPlans.danglingOrMissingHeadVersion.digest",
  "agentExecutionPlans.dimensionUnionClosure.classification",
  "agentExecutionPlans.dimensionUnionClosure.expected.count",
  "agentExecutionPlans.dimensionUnionClosure.expected.digest",
  "agentExecutionPlans.dimensionUnionClosure.observed.count",
  "agentExecutionPlans.dimensionUnionClosure.observed.digest",
  "agentExecutionPlans.exceptions.count",
  "agentExecutionPlans.exceptions.digest",
  "agentExecutionPlans.frameworkOrFallbackDifferences.count",
  "agentExecutionPlans.frameworkOrFallbackDifferences.digest",
  "agentExecutionPlans.inventoryClosure.classification",
  "agentExecutionPlans.inventoryClosure.expected.count",
  "agentExecutionPlans.inventoryClosure.expected.digest",
  "agentExecutionPlans.inventoryClosure.observed.count",
  "agentExecutionPlans.inventoryClosure.observed.digest",
  "agentExecutionPlans.matched.count",
  "agentExecutionPlans.matched.digest",
  "agentExecutionPlans.multiDimensionExceptions.count",
  "agentExecutionPlans.multiDimensionExceptions.digest",
  "agentExecutionPlans.otherLaunchAffectingLegacyFields.count",
  "agentExecutionPlans.otherLaunchAffectingLegacyFields.digest",
  "agentExecutionPlans.partitionClosure.classification",
  "agentExecutionPlans.partitionClosure.expected.count",
  "agentExecutionPlans.partitionClosure.expected.digest",
  "agentExecutionPlans.partitionClosure.observed.count",
  "agentExecutionPlans.partitionClosure.observed.digest",
  "agentExecutionPlans.runnerGroupPolicyDifferences.count",
  "agentExecutionPlans.runnerGroupPolicyDifferences.digest",
  "agentExecutionPlans.runnerProfilePolicyDifferences.count",
  "agentExecutionPlans.runnerProfilePolicyDifferences.digest",
  "agentExecutionPlans.systemEnvironmentDifferences.count",
  "agentExecutionPlans.systemEnvironmentDifferences.digest",
  "agentExecutionPlans.unclassifiedContent.count",
  "agentExecutionPlans.unclassifiedContent.digest",
  "agentExecutionPlans.unsupportedOrInvalidContent.count",
  "agentExecutionPlans.unsupportedOrInvalidContent.digest",
  "capabilities.isolationLevel",
  "capabilities.lockTimeoutMs",
  "capabilities.requiredExtensionCount",
  "capabilities.serverVersionClassification",
  "capabilities.statementTimeoutMs",
  "capabilities.transactionReadOnly",
  "checkpoints.absentLegacyReference.count",
  "checkpoints.absentLegacyReference.digest",
  "checkpoints.distinctVersionHashes.count",
  "checkpoints.distinctVersionHashes.digest",
  "checkpoints.headReferencedVersionHashes.count",
  "checkpoints.headReferencedVersionHashes.digest",
  "checkpoints.invalidLegacyReference.count",
  "checkpoints.invalidLegacyReference.digest",
  "checkpoints.missingVersionReference.count",
  "checkpoints.missingVersionReference.digest",
  "checkpoints.runReferencedVersionHashes.count",
  "checkpoints.runReferencedVersionHashes.digest",
  "checkpoints.sharedVersionHashes.count",
  "checkpoints.sharedVersionHashes.digest",
  "checkpoints.total",
  "checkpoints.validLegacyReference.count",
  "checkpoints.validLegacyReference.digest",
  "danglingHeads.end.count",
  "danglingHeads.end.digest",
  "danglingHeads.exact.count",
  "danglingHeads.exact.digest",
  "danglingHeads.expectedCount",
  "danglingHeads.missingIdentity.count",
  "danglingHeads.missingIdentity.digest",
  "danglingHeads.nonExact.count",
  "danglingHeads.nonExact.digest",
  "danglingHeads.snapshotClassification",
  "danglingHeads.start.count",
  "danglingHeads.start.digest",
  "dependencies.catalog.constraints.classification",
  "dependencies.catalog.constraints.expected.count",
  "dependencies.catalog.constraints.expected.digest",
  "dependencies.catalog.constraints.observed.count",
  "dependencies.catalog.constraints.observed.digest",
  "dependencies.catalog.defaults.classification",
  "dependencies.catalog.defaults.expected.count",
  "dependencies.catalog.defaults.expected.digest",
  "dependencies.catalog.defaults.observed.count",
  "dependencies.catalog.defaults.observed.digest",
  "dependencies.catalog.foreignKeys.classification",
  "dependencies.catalog.foreignKeys.expected.count",
  "dependencies.catalog.foreignKeys.expected.digest",
  "dependencies.catalog.foreignKeys.observed.count",
  "dependencies.catalog.foreignKeys.observed.digest",
  "dependencies.catalog.functions.classification",
  "dependencies.catalog.functions.expected.count",
  "dependencies.catalog.functions.expected.digest",
  "dependencies.catalog.functions.observed.count",
  "dependencies.catalog.functions.observed.digest",
  "dependencies.catalog.indexes.classification",
  "dependencies.catalog.indexes.expected.count",
  "dependencies.catalog.indexes.expected.digest",
  "dependencies.catalog.indexes.observed.count",
  "dependencies.catalog.indexes.observed.digest",
  "dependencies.catalog.otherDependents.classification",
  "dependencies.catalog.otherDependents.expected.count",
  "dependencies.catalog.otherDependents.expected.digest",
  "dependencies.catalog.otherDependents.observed.count",
  "dependencies.catalog.otherDependents.observed.digest",
  "dependencies.catalog.reviewedNonFk.classification",
  "dependencies.catalog.reviewedNonFk.expected.count",
  "dependencies.catalog.reviewedNonFk.expected.digest",
  "dependencies.catalog.reviewedNonFk.observed.count",
  "dependencies.catalog.reviewedNonFk.observed.digest",
  "dependencies.catalog.rewriteDependents.classification",
  "dependencies.catalog.rewriteDependents.expected.count",
  "dependencies.catalog.rewriteDependents.expected.digest",
  "dependencies.catalog.rewriteDependents.observed.count",
  "dependencies.catalog.rewriteDependents.observed.digest",
  "dependencies.catalog.triggers.classification",
  "dependencies.catalog.triggers.expected.count",
  "dependencies.catalog.triggers.expected.digest",
  "dependencies.catalog.triggers.observed.count",
  "dependencies.catalog.triggers.observed.digest",
  "dependencies.repository.legacyIdentifiers.classification",
  "dependencies.repository.legacyIdentifiers.expected.count",
  "dependencies.repository.legacyIdentifiers.expected.digest",
  "dependencies.repository.legacyIdentifiers.observed.count",
  "dependencies.repository.legacyIdentifiers.observed.digest",
  "dependencies.repository.nonTypeScriptConsumers.classification",
  "dependencies.repository.nonTypeScriptConsumers.expected.count",
  "dependencies.repository.nonTypeScriptConsumers.expected.digest",
  "dependencies.repository.nonTypeScriptConsumers.observed.count",
  "dependencies.repository.nonTypeScriptConsumers.observed.digest",
  "dependencies.repository.rawTableLiterals.classification",
  "dependencies.repository.rawTableLiterals.expected.count",
  "dependencies.repository.rawTableLiterals.expected.digest",
  "dependencies.repository.rawTableLiterals.observed.count",
  "dependencies.repository.rawTableLiterals.observed.digest",
  "dependencies.repository.schemaImports.classification",
  "dependencies.repository.schemaImports.expected.count",
  "dependencies.repository.schemaImports.expected.digest",
  "dependencies.repository.schemaImports.observed.count",
  "dependencies.repository.schemaImports.observed.digest",
  "dependencies.repository.transitionValidators.classification",
  "dependencies.repository.transitionValidators.expected.count",
  "dependencies.repository.transitionValidators.expected.digest",
  "dependencies.repository.transitionValidators.observed.count",
  "dependencies.repository.transitionValidators.observed.digest",
  "failureGates[]",
  "heads.crossComposeInsertionProvenanceAgentIds.count",
  "heads.crossComposeInsertionProvenanceAgentIds.digest",
  "heads.danglingAgentIds.count",
  "heads.danglingAgentIds.digest",
  "heads.distinctHashes.count",
  "heads.distinctHashes.digest",
  "heads.fanout.maximumReferenceCount",
  "heads.fanout.sharedHashCount",
  "heads.fanout.singleHashCount",
  "heads.nonNullReferenceCount",
  "heads.nullInsertionProvenanceAgentIds.count",
  "heads.nullInsertionProvenanceAgentIds.digest",
  "heads.presentAgentIds.count",
  "heads.presentAgentIds.digest",
  "heads.sharedHashes.count",
  "heads.sharedHashes.digest",
  "identity.agentComposesTotal",
  "identity.approvedComposeOnlyArtifacts.approvedMemberCount",
  "identity.approvedComposeOnlyArtifacts.classification",
  "identity.approvedComposeOnlyArtifacts.expectedCount",
  "identity.approvedComposeOnlyArtifacts.expectedDigest",
  "identity.approvedComposeOnlyArtifacts.missingApprovedMemberCount",
  "identity.approvedComposeOnlyArtifacts.observedCount",
  "identity.approvedComposeOnlyArtifacts.observedDigest",
  "identity.approvedComposeOnlyArtifacts.unexpected.count",
  "identity.approvedComposeOnlyArtifacts.unexpected.digest",
  "identity.composeOnly.count",
  "identity.composeOnly.digest",
  "identity.createdTimestamps.equal.count",
  "identity.createdTimestamps.equal.digest",
  "identity.createdTimestamps.zeroEarlier.count",
  "identity.createdTimestamps.zeroEarlier.digest",
  "identity.createdTimestamps.zeroLater.count",
  "identity.createdTimestamps.zeroLater.digest",
  "identity.matched.count",
  "identity.matched.digest",
  "identity.nameMismatches.count",
  "identity.nameMismatches.digest",
  "identity.orgMismatches.count",
  "identity.orgMismatches.digest",
  "identity.ownerMismatches.count",
  "identity.ownerMismatches.digest",
  "identity.updatedTimestamps.compose.count",
  "identity.updatedTimestamps.compose.digest",
  "identity.updatedTimestamps.equal.count",
  "identity.updatedTimestamps.equal.digest",
  "identity.updatedTimestamps.zero.count",
  "identity.updatedTimestamps.zero.digest",
  "identity.zeroAgentsTotal",
  "identity.zeroOnly.count",
  "identity.zeroOnly.digest",
  "runs.distinctVersionHashes.count",
  "runs.distinctVersionHashes.digest",
  "runs.headReferencedVersionHashes.count",
  "runs.headReferencedVersionHashes.digest",
  "runs.missingReferences.count",
  "runs.missingReferences.digest",
  "runs.nonNullReferences.count",
  "runs.nonNullReferences.digest",
  "runs.nullVersionReferenceCount",
  "runs.sharedVersionHashes.count",
  "runs.sharedVersionHashes.digest",
  "runs.total",
  "schemaVersion",
  "status",
  "versions.content.canonicalCurrent.count",
  "versions.content.canonicalCurrent.digest",
  "versions.content.hashMismatches.count",
  "versions.content.hashMismatches.digest",
  "versions.content.nonCanonicalLegacy.count",
  "versions.content.nonCanonicalLegacy.digest",
  "versions.content.unsupportedOrInvalid.count",
  "versions.content.unsupportedOrInvalid.digest",
  "versions.orphanComposeIds.count",
  "versions.orphanComposeIds.digest",
  "versions.provenance.composeNullCreatorNull.count",
  "versions.provenance.composeNullCreatorNull.digest",
  "versions.provenance.composeNullCreatorPresent.count",
  "versions.provenance.composeNullCreatorPresent.digest",
  "versions.provenance.composePresentCreatorNull.count",
  "versions.provenance.composePresentCreatorNull.digest",
  "versions.provenance.composePresentCreatorPresent.count",
  "versions.provenance.composePresentCreatorPresent.digest",
  "versions.total",
] as const;

function setOutputPaths(prefix: string): string[] {
  return [`${prefix}.count`, `${prefix}.digest`];
}

function comparisonOutputPaths(prefix: string): string[] {
  return [
    `${prefix}.classification`,
    ...setOutputPaths(`${prefix}.expected`),
    ...setOutputPaths(`${prefix}.observed`),
  ];
}

function activityOutputPaths(prefix: string): string[] {
  return [
    ...ACTIVITY_BUCKETS.flatMap((bucket) => {
      return setOutputPaths(`${prefix}.latestAttributedRun.${bucket}`);
    }),
    ...comparisonOutputPaths(`${prefix}.latestAttributedRun.partitionClosure`),
    ...setOutputPaths(`${prefix}.activeNonterminalRun`),
    ...setOutputPaths(`${prefix}.currentHeadEverExercised`),
  ];
}

function refinementDomainOutputPaths(
  prefix: string,
  primaryClasses: readonly string[],
): string[] {
  return [
    ...primaryClasses.flatMap((primaryClass) => {
      return setOutputPaths(`${prefix}.primary.${primaryClass}`);
    }),
    ...comparisonOutputPaths(`${prefix}.primaryPartitionClosure`),
    ...comparisonOutputPaths(`${prefix}.primaryUnionClosure`),
    ...activityOutputPaths(`${prefix}.activity.parent`),
    ...primaryClasses.flatMap((primaryClass) => {
      return activityOutputPaths(`${prefix}.activity.primary.${primaryClass}`);
    }),
  ];
}

const PREFLIGHT_V3_OUTPUT_ALLOWLIST = [
  ...refinementDomainOutputPaths(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences",
    ENVIRONMENT_PRIMARY_CLASSES,
  ),
  ...ENVIRONMENT_OVERLAP_DIMENSIONS.flatMap((dimension) => {
    return setOutputPaths(
      `agentExecutionPlans.refinements.systemEnvironmentDifferences.overlaps.${dimension}`,
    );
  }),
  ...comparisonOutputPaths(
    "agentExecutionPlans.refinements.systemEnvironmentDifferences.overlapUnionClosure",
  ),
  ...refinementDomainOutputPaths(
    "agentExecutionPlans.refinements.unsupportedOrInvalidContent",
    UNSUPPORTED_PRIMARY_REASONS,
  ),
  ...refinementDomainOutputPaths(
    "agentExecutionPlans.refinements.unclassifiedContent",
    UNCLASSIFIED_PRIMARY_CLASSES,
  ),
  ...comparisonOutputPaths(
    "agentExecutionPlans.runtimeConsumerManifest.discovery",
  ),
  ...comparisonOutputPaths(
    "agentExecutionPlans.runtimeConsumerManifest.reviewedConsumers",
  ),
];

const PREFLIGHT_V4_OUTPUT_ALLOWLIST = [
  "launchSnapshots.total",
  ...setOutputPaths("launchSnapshots.population"),
  ...LAUNCH_SNAPSHOT_DISPOSITIONS.flatMap((disposition) => {
    return setOutputPaths(`launchSnapshots.dispositions.${disposition}`);
  }),
  ...LAUNCH_SNAPSHOT_REASONS.flatMap((reason) => {
    return setOutputPaths(`launchSnapshots.reasons.${reason}`);
  }),
  ...comparisonOutputPaths("launchSnapshots.populationClosure"),
  ...comparisonOutputPaths("launchSnapshots.dispositionPartitionClosure"),
  ...comparisonOutputPaths("launchSnapshots.dispositionDisjointnessClosure"),
  ...comparisonOutputPaths("launchSnapshots.dispositionUnionClosure"),
  ...comparisonOutputPaths("launchSnapshots.reasonPartitionClosure"),
  ...comparisonOutputPaths("launchSnapshots.reasonUnionClosure"),
  ...comparisonOutputPaths("launchSnapshots.reasonCompatibilityClosure"),
];

/** Every and only approved scalar/array path in a complete v4 result. */
export const PREFLIGHT_OUTPUT_ALLOWLIST = [
  ...PREFLIGHT_V2_OUTPUT_ALLOWLIST,
  ...PREFLIGHT_V3_OUTPUT_ALLOWLIST,
  ...PREFLIGHT_V4_OUTPUT_ALLOWLIST,
].sort();

export interface IdentityInventoryRow extends QueryResultRow {
  readonly id: string;
  readonly composePresent: boolean;
  readonly zeroPresent: boolean;
  readonly orgMismatch: boolean;
  readonly ownerMismatch: boolean;
  readonly nameMismatch: boolean;
  readonly createdRelation: "zeroEarlier" | "equal" | "zeroLater" | null;
  readonly updatedSource: "compose" | "equal" | "zero" | null;
}

export interface VersionInventoryRow extends QueryResultRow {
  readonly id: string;
  readonly composeId: string | null;
  readonly composeExists: boolean;
  readonly creatorPresent: boolean;
  readonly content: unknown;
}

export interface HeadInventoryRow extends QueryResultRow {
  readonly composeId: string;
  readonly headVersionId: string;
  readonly versionPresent: boolean;
  readonly insertionComposeId: string | null;
}

export interface RunInventoryRow
  extends QueryResultRow, LaunchSnapshotRunInventoryRow {
  readonly versionPresent: boolean;
}

export interface CheckpointInventoryRow
  extends QueryResultRow, LaunchSnapshotCheckpointInventoryRow {
  readonly id: string;
}

export type ConversationInventoryRow = QueryResultRow &
  LaunchSnapshotConversationInventoryRow;

export interface DanglingInventoryRow extends QueryResultRow {
  readonly composeId: string;
  readonly recordedHash: string;
  readonly agentName: string | null;
}

export interface AgentExecutionPlanInventoryRow extends QueryResultRow {
  readonly id: string;
  readonly agentName: string;
  readonly headVersionId: string | null;
  readonly versionId: string | null;
  readonly insertionComposeId: string | null;
  readonly content: unknown;
  readonly activitySnapshotTime: Date;
  readonly latestAttributedRunAt: Date | null;
  readonly activeNonterminalRun: boolean;
  readonly currentHeadEverExercised: boolean;
  readonly unknownRunStatus: boolean;
}

export interface PreflightInventory {
  readonly identity: readonly IdentityInventoryRow[];
  readonly versions: readonly VersionInventoryRow[];
  readonly heads: readonly HeadInventoryRow[];
  readonly runs: readonly RunInventoryRow[];
  readonly checkpoints: readonly CheckpointInventoryRow[];
  readonly conversations: readonly ConversationInventoryRow[];
  readonly danglingStart: readonly DanglingInventoryRow[];
  readonly danglingEnd: readonly DanglingInventoryRow[];
  readonly agentExecutionPlans: readonly AgentExecutionPlanInventoryRow[];
  readonly catalogDependencies: readonly CatalogDependencyRow[];
}

export interface PreflightCapabilities {
  readonly serverVersionClassification: "supported";
  readonly transactionReadOnly: true;
  readonly isolationLevel: "repeatable read";
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly requiredExtensionCount: 0;
}

export interface PreflightClassificationOptions {
  readonly approvedArtifactMemberDigests?: readonly string[];
  readonly approvedArtifactSetDigest?: string;
  readonly expectedApprovedArtifactCount?: number;
  readonly expectedDanglingHeadCount?: number;
  readonly expectedCatalogDependencies?: Readonly<
    Record<CatalogDependencyKind, readonly string[]>
  >;
  readonly expectedRepositoryDependencies?: RepositoryDependencyManifest;
  readonly observedRepositoryDependencies?: RepositoryDependencyManifest;
  readonly expectedRuntimeContentConsumers?: RuntimeContentConsumerManifest;
  readonly observedRuntimeContentConsumers?: RuntimeContentConsumerManifest;
}

export interface ReadOnlySnapshotOptions {
  readonly signal?: AbortSignal;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export class SanitizedPreflightError extends Error {
  readonly gate: string;

  constructor(gate: string) {
    super(gate);
    this.name = "SanitizedPreflightError";
    this.gate = gate;
  }
}

const SAFE_OUTPUT_LITERALS: ReadonlySet<string> = new Set([
  PREFLIGHT_SCHEMA_VERSION,
  "passed",
  "failed",
  "exact",
  "drift",
  "stable",
  "supported",
  "repeatable read",
]);
const SAFE_FAILURE_GATE_PATTERN = /^[A-Za-z]+(?:[._][A-Za-z]+)*$/u;
const SAFE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function aggregateOutputPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return [`${prefix}[]`];
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .flatMap(([key, child]) => {
        return aggregateOutputPaths(child, prefix ? `${prefix}.${key}` : key);
      })
      .sort();
  }
  return [prefix];
}

function hasSafeAggregateValues(value: unknown, pathPrefix = ""): boolean {
  if (Array.isArray(value)) {
    return (
      pathPrefix === "failureGates" &&
      value.every((gate) => {
        return typeof gate === "string" && SAFE_FAILURE_GATE_PATTERN.test(gate);
      })
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, child]) => {
      return hasSafeAggregateValues(
        child,
        pathPrefix ? `${pathPrefix}.${key}` : key,
      );
    });
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  if (pathPrefix.endsWith(".digest") || pathPrefix.endsWith("Digest")) {
    return SAFE_DIGEST_PATTERN.test(value);
  }
  return SAFE_OUTPUT_LITERALS.has(value);
}

/** Fail closed before a dynamically constructed result reaches stdout. */
export function assertPreflightOutputShape(value: unknown): void {
  const paths = aggregateOutputPaths(value);
  const exactPaths =
    paths.length === PREFLIGHT_OUTPUT_ALLOWLIST.length &&
    paths.every((path, index) => {
      return path === PREFLIGHT_OUTPUT_ALLOWLIST[index];
    });
  if (!exactPaths || !hasSafeAggregateValues(value)) {
    throw new SanitizedPreflightError("probe.output_shape");
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SanitizedPreflightError("probe.cancelled");
}

function classifyThrownError(error: unknown, fallbackGate: string): never {
  if (error instanceof SanitizedPreflightError) throw error;
  if (error instanceof DOMException && error.name === "AbortError") {
    throw new SanitizedPreflightError("probe.cancelled");
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "57014") {
    throw new SanitizedPreflightError("probe.statement_timeout");
  }
  if (code === "55P03") {
    throw new SanitizedPreflightError("probe.lock_timeout");
  }
  throw new SanitizedPreflightError(fallbackGate);
}

async function safeQuery<Row extends QueryResultRow>(
  client: Client,
  signal: AbortSignal | undefined,
  text: string,
  values?: readonly unknown[],
): Promise<readonly Row[]> {
  assertNotAborted(signal);
  const result = await client.query<Row>(text, values as unknown[] | undefined);
  assertNotAborted(signal);
  return result.rows;
}

interface CapabilityRow extends QueryResultRow {
  readonly serverVersion: number;
  readonly readOnly: boolean;
  readonly isolationLevel: string;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

async function executeReadOnlySnapshotTransaction<Value>(
  client: Client,
  options: ReadOnlySnapshotOptions,
  body: (capabilities: PreflightCapabilities) => Promise<Value>,
): Promise<{
  readonly capabilities: PreflightCapabilities;
  readonly value: Value;
}> {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  let transactionStarted = false;
  let bodyError: unknown;
  let result:
    | { readonly capabilities: PreflightCapabilities; readonly value: Value }
    | undefined;

  try {
    assertNotAborted(options.signal);
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transactionStarted = true;
    await client.query(
      `SELECT
         set_config('lock_timeout', $1, true),
         set_config('statement_timeout', $2, true)`,
      [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`],
    );
    const capabilityRows = await safeQuery<CapabilityRow>(
      client,
      options.signal,
      `SELECT
         current_setting('server_version_num')::integer AS "serverVersion",
         current_setting('transaction_read_only') = 'on' AS "readOnly",
         current_setting('transaction_isolation') AS "isolationLevel",
         (SELECT "setting"::integer FROM "pg_settings"
          WHERE "name" = 'lock_timeout') AS "lockTimeoutMs",
         (SELECT "setting"::integer FROM "pg_settings"
          WHERE "name" = 'statement_timeout') AS "statementTimeoutMs"`,
    );
    const capability = capabilityRows[0];
    if (
      !capability ||
      capability.serverVersion < MINIMUM_SERVER_VERSION ||
      !capability.readOnly ||
      capability.isolationLevel !== "repeatable read" ||
      capability.lockTimeoutMs !== lockTimeoutMs ||
      capability.statementTimeoutMs !== statementTimeoutMs
    ) {
      throw new SanitizedPreflightError("probe.capability_gate");
    }
    const capabilities: PreflightCapabilities = {
      serverVersionClassification: "supported",
      transactionReadOnly: true,
      isolationLevel: "repeatable read",
      lockTimeoutMs,
      statementTimeoutMs,
      requiredExtensionCount: 0,
    };
    result = { capabilities, value: await body(capabilities) };
  } catch (error) {
    bodyError = error;
  }

  if (transactionStarted) {
    try {
      await client.query("ROLLBACK");
    } catch {
      if (options.signal?.aborted) {
        throw new SanitizedPreflightError("probe.cancelled");
      }
      throw new SanitizedPreflightError("probe.transaction_cleanup");
    }
  }
  if (options.signal?.aborted) {
    throw new SanitizedPreflightError("probe.cancelled");
  }
  if (bodyError !== undefined)
    classifyThrownError(bodyError, "probe.inventory");
  if (!result) throw new SanitizedPreflightError("probe.transaction_start");
  return result;
}

export async function withReadOnlySnapshot<Value>(
  client: Client,
  options: ReadOnlySnapshotOptions,
  body: (capabilities: PreflightCapabilities) => Promise<Value>,
): Promise<{
  readonly capabilities: PreflightCapabilities;
  readonly value: Value;
}> {
  // node-postgres 8 does not accept AbortSignal in QueryConfig. Closing this
  // probe-owned connection interrupts an in-flight query and aborts its
  // read-only transaction; callers receive only the fixed cancellation gate.
  const cancelInFlightQuery = (): void => {
    void client.end().catch(() => {});
  };
  options.signal?.addEventListener("abort", cancelInFlightQuery, {
    once: true,
  });
  if (options.signal?.aborted) cancelInFlightQuery();
  try {
    return await executeReadOnlySnapshotTransaction(client, options, body);
  } finally {
    options.signal?.removeEventListener("abort", cancelInFlightQuery);
  }
}

function frameTuple(parts: readonly string[]): string {
  return parts
    .map((part) => {
      return `${Buffer.byteLength(part, "utf8")}:${part}`;
    })
    .join("|");
}

function comparison(
  domain: string,
  expected: readonly string[],
  observed: readonly string[],
): {
  readonly expected: SetFingerprint;
  readonly observed: SetFingerprint;
  readonly classification: "exact" | "drift";
} {
  const expectedMetric = fingerprintSortedSet(`${domain}:expected`, expected);
  const observedMetric = fingerprintSortedSet(`${domain}:expected`, observed);
  return {
    expected: expectedMetric,
    observed: observedMetric,
    classification:
      expectedMetric.count === observedMetric.count &&
      expectedMetric.digest === observedMetric.digest
        ? "exact"
        : "drift",
  };
}

function recordSet(
  domain: string,
  rows: readonly { readonly id: string }[],
): SetFingerprint {
  return fingerprintSortedSet(
    domain,
    rows.map((row) => {
      return row.id;
    }),
  );
}

function headRecordSet(
  domain: string,
  rows: readonly HeadInventoryRow[],
): SetFingerprint {
  return fingerprintSortedSet(
    domain,
    rows.map((row) => {
      return row.composeId;
    }),
  );
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function checkpointVersionId(
  snapshot: unknown,
):
  | { readonly classification: "absent" }
  | { readonly classification: "invalid" }
  | { readonly classification: "valid"; readonly versionId: string } {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return { classification: "invalid" };
  }
  if (!("agentComposeVersionId" in snapshot)) {
    return { classification: "absent" };
  }
  const value = (snapshot as { readonly agentComposeVersionId?: unknown })
    .agentComposeVersionId;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    return { classification: "invalid" };
  }
  return { classification: "valid", versionId: value };
}

interface IdentityClassificationInput {
  readonly rows: readonly IdentityInventoryRow[];
  readonly approvedMemberDigests: ReadonlySet<string>;
  readonly approvedSetDigest: string;
  readonly expectedApprovedCount: number;
}

function classifyIdentity(
  input: IdentityClassificationInput,
  failureGates: Set<string>,
) {
  const composeRows = input.rows.filter((row) => {
    return row.composePresent;
  });
  const zeroRows = input.rows.filter((row) => {
    return row.zeroPresent;
  });
  const matchedRows = input.rows.filter((row) => {
    return row.composePresent && row.zeroPresent;
  });
  const composeOnlyRows = input.rows.filter((row) => {
    return row.composePresent && !row.zeroPresent;
  });
  const zeroOnlyRows = input.rows.filter((row) => {
    return !row.composePresent && row.zeroPresent;
  });
  const orgMismatchRows = matchedRows.filter((row) => {
    return row.orgMismatch;
  });
  const ownerMismatchRows = matchedRows.filter((row) => {
    return row.ownerMismatch;
  });
  const nameMismatchRows = matchedRows.filter((row) => {
    return row.nameMismatch;
  });
  const composeOnlyIds = composeOnlyRows.map((row) => {
    return row.id;
  });
  const observedApprovedSet = fingerprintSortedSet(
    "approved-artifact-set",
    composeOnlyIds,
  );
  const approvedIds = composeOnlyIds.filter((id) => {
    return input.approvedMemberDigests.has(
      fingerprintMember("approved-artifact-member", id),
    );
  });
  const unexpectedArtifactIds = composeOnlyIds.filter((id) => {
    return !input.approvedMemberDigests.has(
      fingerprintMember("approved-artifact-member", id),
    );
  });
  const approvedClassification =
    composeOnlyIds.length === input.expectedApprovedCount &&
    approvedIds.length === input.expectedApprovedCount &&
    observedApprovedSet.digest === input.approvedSetDigest
      ? "exact"
      : "drift";

  if (approvedClassification === "drift") {
    failureGates.add("identity.approved_artifact_drift");
  }
  if (zeroOnlyRows.length > 0) failureGates.add("identity.zero_only");
  if (orgMismatchRows.length > 0) failureGates.add("identity.org_mismatch");
  if (ownerMismatchRows.length > 0) {
    failureGates.add("identity.owner_mismatch");
  }
  if (nameMismatchRows.length > 0) {
    failureGates.add("identity.name_mismatch");
  }

  return {
    agentComposesTotal: composeRows.length,
    zeroAgentsTotal: zeroRows.length,
    matched: recordSet("identity:matched-agent-ids", matchedRows),
    composeOnly: recordSet("identity:compose-only-agent-ids", composeOnlyRows),
    zeroOnly: recordSet("identity:zero-only-agent-ids", zeroOnlyRows),
    orgMismatches: recordSet(
      "identity:org-mismatch-agent-ids",
      orgMismatchRows,
    ),
    ownerMismatches: recordSet(
      "identity:owner-mismatch-agent-ids",
      ownerMismatchRows,
    ),
    nameMismatches: recordSet(
      "identity:name-mismatch-agent-ids",
      nameMismatchRows,
    ),
    createdTimestamps: {
      zeroEarlier: recordSet(
        "identity:created-zero-earlier-agent-ids",
        matchedRows.filter((row) => {
          return row.createdRelation === "zeroEarlier";
        }),
      ),
      equal: recordSet(
        "identity:created-equal-agent-ids",
        matchedRows.filter((row) => {
          return row.createdRelation === "equal";
        }),
      ),
      zeroLater: recordSet(
        "identity:created-zero-later-agent-ids",
        matchedRows.filter((row) => {
          return row.createdRelation === "zeroLater";
        }),
      ),
    },
    updatedTimestamps: {
      compose: recordSet(
        "identity:updated-compose-agent-ids",
        matchedRows.filter((row) => {
          return row.updatedSource === "compose";
        }),
      ),
      equal: recordSet(
        "identity:updated-equal-agent-ids",
        matchedRows.filter((row) => {
          return row.updatedSource === "equal";
        }),
      ),
      zero: recordSet(
        "identity:updated-zero-agent-ids",
        matchedRows.filter((row) => {
          return row.updatedSource === "zero";
        }),
      ),
    },
    approvedComposeOnlyArtifacts: {
      expectedCount: input.expectedApprovedCount,
      expectedDigest: input.approvedSetDigest,
      observedCount: observedApprovedSet.count,
      observedDigest: observedApprovedSet.digest,
      approvedMemberCount: approvedIds.length,
      missingApprovedMemberCount: Math.max(
        0,
        input.expectedApprovedCount - approvedIds.length,
      ),
      unexpected: fingerprintSortedSet(
        "identity:unexpected-compose-only-agent-ids",
        unexpectedArtifactIds,
      ),
      classification: approvedClassification,
    },
  };
}

const AGENT_EXECUTION_PLAN_DIMENSIONS = [
  "danglingOrMissingHeadVersion",
  "unsupportedOrInvalidContent",
  "frameworkOrFallbackDifferences",
  "systemEnvironmentDifferences",
  "runnerGroupPolicyDifferences",
  "runnerProfilePolicyDifferences",
  "agentInstructionsMarkerOrMountDifferences",
  "composeArtifactOrVolumeDifferences",
  "otherLaunchAffectingLegacyFields",
  "unclassifiedContent",
] as const;

type AgentExecutionPlanDimension =
  (typeof AGENT_EXECUTION_PLAN_DIMENSIONS)[number];

function cardinalityAwareComparison(
  domain: string,
  expected: readonly string[],
  observed: readonly string[],
): ReturnType<typeof comparison> {
  const result = comparison(domain, expected, observed);
  return {
    ...result,
    classification:
      expected.length === result.expected.count &&
      observed.length === result.observed.count &&
      expected.length === observed.length &&
      result.classification === "exact"
        ? "exact"
        : "drift",
  };
}

function hasInvalidActiveVolumeReference(args: {
  readonly declarations: readonly string[] | undefined;
  readonly volumeNames: ReadonlySet<string>;
}): boolean {
  return (args.declarations ?? []).some((declaration) => {
    const [name, mountPath, extra] = declaration.split(":");
    return (
      extra !== undefined ||
      !name?.trim() ||
      !mountPath?.trim() ||
      !args.volumeNames.has(name.trim())
    );
  });
}

function hasLegacyEnvironmentInfluence(
  environment: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!environment) return false;
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN.environment;
  const runtimeOverrideKeys = new Set<string>(plan.runtimeOverrideKeys);
  return Object.keys(environment).some((key) => {
    return (
      !runtimeOverrideKeys.has(key) &&
      !plan.legacyRemovedPrefixes.some((prefix) => {
        return key.startsWith(prefix);
      })
    );
  });
}

type ParsedAgentComposeContent = ReturnType<
  typeof agentComposeApiContentSchema.parse
>;
type ParsedAgentDefinition = ParsedAgentComposeContent["agents"][string];

type ValidatedAgentExecutionPlan =
  | {
      readonly classification: "exception";
      readonly dimension: AgentExecutionPlanDimension;
    }
  | {
      readonly classification: "supported";
      readonly content: ParsedAgentComposeContent;
      readonly activeAgentName: string;
      readonly activeAgent: ParsedAgentDefinition;
    };

function isMissingCurrentPlanHead(
  row: AgentExecutionPlanInventoryRow,
): boolean {
  return (
    row.headVersionId === null || row.versionId === null || row.content === null
  );
}

function hasValidCurrentPlanHash(
  row: AgentExecutionPlanInventoryRow,
): row is AgentExecutionPlanInventoryRow & {
  readonly headVersionId: string;
  readonly versionId: string;
  readonly content: Record<string, unknown>;
} {
  return (
    row.versionId !== null &&
    row.versionId === row.headVersionId &&
    typeof row.content === "object" &&
    row.content !== null &&
    !Array.isArray(row.content) &&
    computeComposeVersionId(row.content as Record<string, unknown>) ===
      row.versionId
  );
}

function validateAgentExecutionPlanRow(
  row: AgentExecutionPlanInventoryRow,
): ValidatedAgentExecutionPlan {
  if (isMissingCurrentPlanHead(row)) {
    return {
      classification: "exception",
      dimension: "danglingOrMissingHeadVersion",
    };
  }
  if (!hasValidCurrentPlanHash(row)) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  const parsed = agentComposeApiContentSchema.safeParse(row.content);
  if (!parsed.success) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  if (!isDeepStrictEqual(row.content, parsed.data)) {
    // Zod strips unknown object keys. Any such key could acquire runtime
    // meaning later, so the shadow must not silently call it parity.
    return { classification: "exception", dimension: "unclassifiedContent" };
  }
  const firstEntry = Object.entries(parsed.data.agents)[0];
  const activeAgentName = firstEntry?.[0];
  const activeAgent = firstEntry?.[1];
  if (!activeAgentName || !activeAgent) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  if (
    hasInvalidActiveVolumeReference({
      declarations: activeAgent.volumes,
      volumeNames: new Set(Object.keys(parsed.data.volumes ?? {})),
    })
  ) {
    return {
      classification: "exception",
      dimension: "unsupportedOrInvalidContent",
    };
  }
  return {
    classification: "supported",
    content: parsed.data,
    activeAgentName,
    activeAgent,
  };
}

function semanticAgentExecutionPlanDimensions(
  row: AgentExecutionPlanInventoryRow,
  validated: Extract<
    ValidatedAgentExecutionPlan,
    { readonly classification: "supported" }
  >,
): Set<AgentExecutionPlanDimension> {
  const dimensions = new Set<AgentExecutionPlanDimension>();
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN;
  const { activeAgent, activeAgentName, content } = validated;
  // Selected providers supply the same effective framework to both plans.
  // Compare only the legacy value that remains capable of acting as fallback.
  if (activeAgent.framework !== plan.framework.fallback) {
    dimensions.add("frameworkOrFallbackDifferences");
  }
  if (hasLegacyEnvironmentInfluence(activeAgent.environment)) {
    dimensions.add("systemEnvironmentDifferences");
  }
  if (activeAgent.experimental_runner !== undefined) {
    dimensions.add("runnerGroupPolicyDifferences");
  }
  if (
    activeAgent.experimental_profile !== undefined &&
    activeAgent.experimental_profile !== plan.runner.profile.fallback
  ) {
    dimensions.add("runnerProfilePolicyDifferences");
  }
  if (
    plan.instructions.enabled &&
    (activeAgent.instructions === undefined ||
      activeAgentName !== row.agentName)
  ) {
    dimensions.add("agentInstructionsMarkerOrMountDifferences");
  }
  if (
    (content.artifacts?.length ?? 0) > 0 ||
    (activeAgent.volumes?.length ?? 0) > 0
  ) {
    dimensions.add("composeArtifactOrVolumeDifferences");
  }
  if (activeAgentName !== row.agentName) {
    dimensions.add("otherLaunchAffectingLegacyFields");
  }
  return dimensions;
}

function dimensionsForAgentExecutionPlanRows(
  rows: readonly AgentExecutionPlanInventoryRow[],
): Set<AgentExecutionPlanDimension> {
  if (rows.length === 0) {
    return new Set(["danglingOrMissingHeadVersion"]);
  }
  const row = rows[0];
  if (rows.length !== 1 || !row) {
    return new Set(["unclassifiedContent"]);
  }
  const validated = validateAgentExecutionPlanRow(row);
  if (validated.classification === "exception") {
    return new Set([validated.dimension]);
  }
  return semanticAgentExecutionPlanDimensions(row, validated);
}

function classifyAgentExecutionPlans(
  identityRows: readonly IdentityInventoryRow[],
  rows: readonly AgentExecutionPlanInventoryRow[],
  expectedRuntimeConsumers: RuntimeContentConsumerManifest,
  observedRuntimeConsumers: RuntimeContentConsumerManifest,
  failureGates: Set<string>,
) {
  const expectedMatchedIds = identityRows
    .filter((row) => {
      return row.composePresent && row.zeroPresent;
    })
    .map((row) => {
      return row.id;
    });
  const observedMatchedIds = rows.map((row) => {
    return row.id;
  });
  const rowsById = new Map<string, AgentExecutionPlanInventoryRow[]>();
  for (const row of rows) {
    const existing = rowsById.get(row.id);
    if (existing) existing.push(row);
    else rowsById.set(row.id, [row]);
  }

  const dimensionIds = Object.fromEntries(
    AGENT_EXECUTION_PLAN_DIMENSIONS.map((dimension) => {
      return [dimension, new Set<string>()];
    }),
  ) as Record<AgentExecutionPlanDimension, Set<string>>;
  const parityIds: string[] = [];
  const exceptionIds: string[] = [];
  const multiDimensionIds: string[] = [];

  for (const id of expectedMatchedIds) {
    const matches = rowsById.get(id) ?? [];
    const dimensions = dimensionsForAgentExecutionPlanRows(matches);

    if (dimensions.size === 0) {
      parityIds.push(id);
      continue;
    }
    exceptionIds.push(id);
    if (dimensions.size > 1) multiDimensionIds.push(id);
    for (const dimension of dimensions) {
      dimensionIds[dimension].add(id);
    }
  }

  const inventoryClosure = cardinalityAwareComparison(
    "agent-execution-plans:inventory-closure",
    expectedMatchedIds,
    observedMatchedIds,
  );
  const partitionClosure = cardinalityAwareComparison(
    "agent-execution-plans:partition-closure",
    expectedMatchedIds,
    [...parityIds, ...exceptionIds],
  );
  const dimensionUnionIds = [
    ...new Set(
      AGENT_EXECUTION_PLAN_DIMENSIONS.flatMap((dimension) => {
        return [...dimensionIds[dimension]];
      }),
    ),
  ];
  const dimensionUnionClosure = cardinalityAwareComparison(
    "agent-execution-plans:dimension-union-closure",
    exceptionIds,
    dimensionUnionIds,
  );

  for (const [name, closure] of [
    ["inventoryClosure", inventoryClosure],
    ["partitionClosure", partitionClosure],
    ["dimensionUnionClosure", dimensionUnionClosure],
  ] as const) {
    if (closure.classification === "drift") {
      failureGates.add(`agentExecutionPlans.${name}`);
    }
  }
  for (const dimension of AGENT_EXECUTION_PLAN_DIMENSIONS) {
    if (dimensionIds[dimension].size > 0) {
      failureGates.add(`agentExecutionPlans.${dimension}`);
    }
  }
  if (multiDimensionIds.length > 0) {
    failureGates.add("agentExecutionPlans.multiDimensionExceptions");
  }

  const runtimeConsumerManifest = {
    discovery: comparison(
      "agent-execution-plans:runtime-consumer-manifest:discovery",
      expectedRuntimeConsumers.discovery,
      observedRuntimeConsumers.discovery,
    ),
    reviewedConsumers: comparison(
      "agent-execution-plans:runtime-consumer-manifest:reviewed-consumers",
      expectedRuntimeConsumers.reviewedConsumers,
      observedRuntimeConsumers.reviewedConsumers,
    ),
  };
  for (const [kind, result] of Object.entries(runtimeConsumerManifest)) {
    if (result.classification === "drift") {
      failureGates.add(`agentExecutionPlans.runtimeConsumerManifest.${kind}`);
    }
  }

  const refinements = classifyExceptionRefinements({
    rowsById,
    environmentIds: [...dimensionIds.systemEnvironmentDifferences],
    unsupportedIds: [...dimensionIds.unsupportedOrInvalidContent],
    unclassifiedIds: [...dimensionIds.unclassifiedContent],
    failureGates,
  });

  const dimensionOutput = Object.fromEntries(
    AGENT_EXECUTION_PLAN_DIMENSIONS.map((dimension) => {
      return [
        dimension,
        fingerprintSortedSet(`agent-execution-plans:${dimension}:agent-ids`, [
          ...dimensionIds[dimension],
        ]),
      ];
    }),
  ) as Record<AgentExecutionPlanDimension, SetFingerprint>;

  return {
    matched: fingerprintSortedSet(
      "agent-execution-plans:matched-agent-ids",
      expectedMatchedIds,
    ),
    completeSemanticParity: fingerprintSortedSet(
      "agent-execution-plans:complete-semantic-parity-agent-ids",
      parityIds,
    ),
    exceptions: fingerprintSortedSet(
      "agent-execution-plans:exception-agent-ids",
      exceptionIds,
    ),
    ...dimensionOutput,
    multiDimensionExceptions: fingerprintSortedSet(
      "agent-execution-plans:multi-dimension-exception-agent-ids",
      multiDimensionIds,
    ),
    inventoryClosure,
    partitionClosure,
    dimensionUnionClosure,
    refinements,
    runtimeConsumerManifest,
  };
}

type VersionContentClassification = "canonical" | "nonCanonical" | "invalid";

function classifyVersionContent(version: VersionInventoryRow): {
  readonly classification: VersionContentClassification;
  readonly hashMismatch: boolean;
} {
  const content = version.content;
  if (
    content === null ||
    typeof content !== "object" ||
    Array.isArray(content)
  ) {
    return { classification: "invalid", hashMismatch: false };
  }
  const exactContentHash =
    computeComposeVersionId(content as Record<string, unknown>) === version.id;
  const parsed = agentComposeApiContentSchema.safeParse(content);
  if (!parsed.success || !exactContentHash) {
    return { classification: "invalid", hashMismatch: !exactContentHash };
  }
  const agentNames = Object.keys(parsed.data.agents);
  const canonical =
    agentNames.length === 1 &&
    isDeepStrictEqual(content, buildZeroAgentComposeContent(agentNames[0]!));
  return {
    classification: canonical ? "canonical" : "nonCanonical",
    hashMismatch: false,
  };
}

function classifyVersions(
  rows: readonly VersionInventoryRow[],
  failureGates: Set<string>,
) {
  const composePresentCreatorPresent: VersionInventoryRow[] = [];
  const composePresentCreatorNull: VersionInventoryRow[] = [];
  const composeNullCreatorPresent: VersionInventoryRow[] = [];
  const composeNullCreatorNull: VersionInventoryRow[] = [];
  const orphanComposeIds: string[] = [];
  const canonicalVersions: VersionInventoryRow[] = [];
  const nonCanonicalVersions: VersionInventoryRow[] = [];
  const invalidVersions: VersionInventoryRow[] = [];
  const contentHashMismatches: VersionInventoryRow[] = [];

  for (const version of rows) {
    if (version.composeId !== null && version.creatorPresent) {
      composePresentCreatorPresent.push(version);
    } else if (version.composeId !== null) {
      composePresentCreatorNull.push(version);
    } else if (version.creatorPresent) {
      composeNullCreatorPresent.push(version);
    } else {
      composeNullCreatorNull.push(version);
    }
    if (version.composeId !== null && !version.composeExists) {
      orphanComposeIds.push(version.composeId);
    }

    const content = classifyVersionContent(version);
    if (content.classification === "canonical") {
      canonicalVersions.push(version);
    } else if (content.classification === "nonCanonical") {
      nonCanonicalVersions.push(version);
    } else {
      invalidVersions.push(version);
    }
    if (content.hashMismatch) contentHashMismatches.push(version);
  }

  if (orphanComposeIds.length > 0) {
    failureGates.add("versions.orphan_compose");
  }
  if (invalidVersions.length > 0) {
    failureGates.add("versions.invalid_content");
  }
  if (contentHashMismatches.length > 0) {
    failureGates.add("versions.content_hash_mismatch");
  }

  return {
    total: rows.length,
    provenance: {
      composePresentCreatorPresent: recordSet(
        "versions:compose-present-creator-present",
        composePresentCreatorPresent,
      ),
      composePresentCreatorNull: recordSet(
        "versions:compose-present-creator-null",
        composePresentCreatorNull,
      ),
      composeNullCreatorPresent: recordSet(
        "versions:compose-null-creator-present",
        composeNullCreatorPresent,
      ),
      composeNullCreatorNull: recordSet(
        "versions:compose-null-creator-null",
        composeNullCreatorNull,
      ),
    },
    orphanComposeIds: fingerprintSortedSet(
      "versions:orphan-compose-ids",
      orphanComposeIds,
    ),
    content: {
      canonicalCurrent: recordSet(
        "versions:canonical-current",
        canonicalVersions,
      ),
      nonCanonicalLegacy: recordSet(
        "versions:noncanonical-legacy",
        nonCanonicalVersions,
      ),
      unsupportedOrInvalid: recordSet("versions:invalid", invalidVersions),
      hashMismatches: recordSet(
        "versions:content-hash-mismatch",
        contentHashMismatches,
      ),
    },
  };
}

function classifyHeads(rows: readonly HeadInventoryRow[]) {
  const fanout = new Map<string, number>();
  for (const head of rows) increment(fanout, head.headVersionId);
  const distinctHashes = [...fanout.keys()];
  const sharedHashes = [...fanout.entries()]
    .filter(([, count]) => {
      return count > 1;
    })
    .map(([hash]) => {
      return hash;
    });
  const present = rows.filter((head) => {
    return head.versionPresent;
  });
  const dangling = rows.filter((head) => {
    return !head.versionPresent;
  });
  const crossCompose = present.filter((head) => {
    return (
      head.insertionComposeId !== null &&
      head.insertionComposeId !== head.composeId
    );
  });
  const nullProvenance = present.filter((head) => {
    return head.insertionComposeId === null;
  });

  return {
    distinctHashes,
    output: {
      nonNullReferenceCount: rows.length,
      distinctHashes: fingerprintSortedSet(
        "heads:distinct-version-hashes",
        distinctHashes,
      ),
      presentAgentIds: headRecordSet("heads:present-agent-ids", present),
      danglingAgentIds: headRecordSet("heads:dangling-agent-ids", dangling),
      sharedHashes: fingerprintSortedSet(
        "heads:shared-version-hashes",
        sharedHashes,
      ),
      fanout: {
        singleHashCount: [...fanout.values()].filter((count) => {
          return count === 1;
        }).length,
        sharedHashCount: sharedHashes.length,
        maximumReferenceCount: Math.max(0, ...fanout.values()),
      },
      nullInsertionProvenanceAgentIds: headRecordSet(
        "heads:null-insertion-provenance-agent-ids",
        nullProvenance,
      ),
      crossComposeInsertionProvenanceAgentIds: headRecordSet(
        "heads:cross-compose-provenance-agent-ids",
        crossCompose,
      ),
    },
  };
}

function classifyRuns(
  rows: readonly RunInventoryRow[],
  headHashes: ReadonlySet<string>,
  failureGates: Set<string>,
) {
  const fanout = new Map<string, number>();
  const nonNull = rows.filter((run) => {
    return run.versionId !== null;
  });
  const missing = nonNull.filter((run) => {
    return !run.versionPresent;
  });
  for (const run of nonNull) increment(fanout, run.versionId!);
  const versionHashes = [...fanout.keys()];
  const sharedHashes = [...fanout.entries()]
    .filter(([, count]) => {
      return count > 1;
    })
    .map(([hash]) => {
      return hash;
    });
  const headReferencedHashes = versionHashes.filter((hash) => {
    return headHashes.has(hash);
  });
  if (missing.length > 0) failureGates.add("runs.missing_version");

  return {
    versionHashes,
    output: {
      total: rows.length,
      nullVersionReferenceCount: rows.length - nonNull.length,
      nonNullReferences: recordSet("runs:non-null-reference-run-ids", nonNull),
      missingReferences: recordSet("runs:missing-reference-run-ids", missing),
      distinctVersionHashes: fingerprintSortedSet(
        "runs:distinct-version-hashes",
        versionHashes,
      ),
      sharedVersionHashes: fingerprintSortedSet(
        "runs:shared-version-hashes",
        sharedHashes,
      ),
      headReferencedVersionHashes: fingerprintSortedSet(
        "runs:head-referenced-version-hashes",
        headReferencedHashes,
      ),
    },
  };
}

function classifyCheckpoints(
  rows: readonly CheckpointInventoryRow[],
  versionIds: ReadonlySet<string>,
  runHashes: ReadonlySet<string>,
  headHashes: ReadonlySet<string>,
  failureGates: Set<string>,
) {
  const absent: CheckpointInventoryRow[] = [];
  const invalid: CheckpointInventoryRow[] = [];
  const valid: CheckpointInventoryRow[] = [];
  const missing: CheckpointInventoryRow[] = [];
  const fanout = new Map<string, number>();

  for (const checkpoint of rows) {
    const reference = checkpointVersionId(checkpoint.snapshot);
    if (reference.classification === "absent") {
      absent.push(checkpoint);
    } else if (reference.classification === "invalid") {
      invalid.push(checkpoint);
    } else {
      valid.push(checkpoint);
      increment(fanout, reference.versionId);
      if (!versionIds.has(reference.versionId)) missing.push(checkpoint);
    }
  }
  const versionHashes = [...fanout.keys()];
  const sharedHashes = [...fanout.entries()]
    .filter(([, count]) => {
      return count > 1;
    })
    .map(([hash]) => {
      return hash;
    });
  const runReferencedHashes = versionHashes.filter((hash) => {
    return runHashes.has(hash);
  });
  const headReferencedHashes = versionHashes.filter((hash) => {
    return headHashes.has(hash);
  });
  if (invalid.length > 0) {
    failureGates.add("checkpoints.invalid_reference");
  }
  if (missing.length > 0) {
    failureGates.add("checkpoints.missing_version");
  }

  return {
    total: rows.length,
    absentLegacyReference: recordSet(
      "checkpoints:absent-reference-checkpoint-ids",
      absent,
    ),
    validLegacyReference: recordSet(
      "checkpoints:valid-reference-checkpoint-ids",
      valid,
    ),
    invalidLegacyReference: recordSet(
      "checkpoints:invalid-reference-checkpoint-ids",
      invalid,
    ),
    missingVersionReference: recordSet(
      "checkpoints:missing-reference-checkpoint-ids",
      missing,
    ),
    distinctVersionHashes: fingerprintSortedSet(
      "checkpoints:distinct-version-hashes",
      versionHashes,
    ),
    sharedVersionHashes: fingerprintSortedSet(
      "checkpoints:shared-version-hashes",
      sharedHashes,
    ),
    runReferencedVersionHashes: fingerprintSortedSet(
      "checkpoints:run-referenced-version-hashes",
      runReferencedHashes,
    ),
    headReferencedVersionHashes: fingerprintSortedSet(
      "checkpoints:head-referenced-version-hashes",
      headReferencedHashes,
    ),
  };
}

function danglingStabilityMetric(
  rows: readonly DanglingInventoryRow[],
): SetFingerprint {
  return fingerprintSortedSet(
    "dangling-stability-records",
    rows.map((row) => {
      return frameTuple([row.composeId, row.recordedHash, row.agentName ?? ""]);
    }),
  );
}

function classifyDangling(
  start: readonly DanglingInventoryRow[],
  end: readonly DanglingInventoryRow[],
  expectedCount: number,
  failureGates: Set<string>,
) {
  const exact: DanglingInventoryRow[] = [];
  const nonExact: DanglingInventoryRow[] = [];
  const missingIdentity: DanglingInventoryRow[] = [];

  for (const dangling of start) {
    if (dangling.agentName === null) {
      missingIdentity.push(dangling);
      continue;
    }
    const expectedHash = computeComposeVersionId(
      buildZeroAgentComposeContent(dangling.agentName),
    );
    if (expectedHash === dangling.recordedHash) exact.push(dangling);
    else nonExact.push(dangling);
  }
  const startStability = danglingStabilityMetric(start);
  const endStability = danglingStabilityMetric(end);
  const stable =
    startStability.count === endStability.count &&
    startStability.digest === endStability.digest;

  if (!stable) failureGates.add("dangling.snapshot_drift");
  if (start.length !== expectedCount) failureGates.add("dangling.count_drift");
  if (missingIdentity.length > 0) {
    failureGates.add("dangling.missing_identity");
  }
  if (nonExact.length > 0) failureGates.add("dangling.non_exact");

  return {
    expectedCount,
    start: fingerprintSortedSet(
      "dangling:agent-ids",
      start.map((row) => {
        return row.composeId;
      }),
    ),
    end: fingerprintSortedSet(
      "dangling:agent-ids",
      end.map((row) => {
        return row.composeId;
      }),
    ),
    exact: fingerprintSortedSet(
      "dangling:exact-agent-ids",
      exact.map((row) => {
        return row.composeId;
      }),
    ),
    nonExact: fingerprintSortedSet(
      "dangling:nonexact-agent-ids",
      nonExact.map((row) => {
        return row.composeId;
      }),
    ),
    missingIdentity: fingerprintSortedSet(
      "dangling:missing-identity-agent-ids",
      missingIdentity.map((row) => {
        return row.composeId;
      }),
    ),
    snapshotClassification: stable ? "stable" : "drift",
  };
}

function classifyDependencies(
  catalogRows: readonly CatalogDependencyRow[],
  expectedCatalog: Readonly<Record<CatalogDependencyKind, readonly string[]>>,
  expectedRepository: RepositoryDependencyManifest,
  observedRepository: RepositoryDependencyManifest,
  failureGates: Set<string>,
) {
  const catalogObserved = Object.fromEntries(
    CATALOG_DEPENDENCY_KINDS.map((kind) => {
      return [
        kind,
        catalogRows
          .filter((row) => {
            return row.kind === kind;
          })
          .map((row) => {
            return row.entry;
          })
          .sort(),
      ];
    }),
  ) as Record<CatalogDependencyKind, string[]>;
  const catalog = Object.fromEntries(
    CATALOG_DEPENDENCY_KINDS.map((kind) => {
      const value = comparison(
        `dependencies:catalog:${kind}`,
        expectedCatalog[kind],
        catalogObserved[kind],
      );
      if (value.classification === "drift") {
        failureGates.add(`dependencies.catalog.${kind}`);
      }
      return [kind, value];
    }),
  );
  const repository = {
    schemaImports: comparison(
      "dependencies:repository:schema-imports",
      expectedRepository.schemaImports,
      observedRepository.schemaImports,
    ),
    legacyIdentifiers: comparison(
      "dependencies:repository:legacy-identifiers",
      expectedRepository.legacyIdentifiers,
      observedRepository.legacyIdentifiers,
    ),
    rawTableLiterals: comparison(
      "dependencies:repository:raw-table-literals",
      expectedRepository.rawTableLiterals,
      observedRepository.rawTableLiterals,
    ),
    nonTypeScriptConsumers: comparison(
      "dependencies:repository:non-typescript-consumers",
      expectedRepository.nonTypeScriptConsumers,
      observedRepository.nonTypeScriptConsumers,
    ),
    transitionValidators: comparison(
      "dependencies:repository:transition-validators",
      expectedRepository.transitionValidators,
      observedRepository.transitionValidators,
    ),
  };
  for (const [kind, value] of Object.entries(repository)) {
    if (value.classification === "drift") {
      failureGates.add(`dependencies.repository.${kind}`);
    }
  }
  return { catalog, repository };
}

export function classifyPreflightInventory(
  capabilities: PreflightCapabilities,
  inventory: PreflightInventory,
  options: PreflightClassificationOptions = {},
) {
  const expectedApprovedCount = options.expectedApprovedArtifactCount ?? 6;
  const expectedDanglingCount =
    options.expectedDanglingHeadCount ?? DEFAULT_EXPECTED_DANGLING_HEAD_COUNT;
  const expectedCatalog =
    options.expectedCatalogDependencies ?? EXPECTED_CATALOG_DEPENDENCIES;
  const expectedRepository =
    options.expectedRepositoryDependencies ?? EXPECTED_REPOSITORY_DEPENDENCIES;
  const observedRepository =
    options.observedRepositoryDependencies ?? expectedRepository;
  const expectedRuntimeConsumers =
    options.expectedRuntimeContentConsumers ??
    EXPECTED_RUNTIME_CONTENT_CONSUMER_MANIFEST;
  const observedRuntimeConsumers =
    options.observedRuntimeContentConsumers ?? expectedRuntimeConsumers;
  const failureGates = new Set<string>();
  const identity = classifyIdentity(
    {
      rows: inventory.identity,
      approvedMemberDigests: new Set(
        options.approvedArtifactMemberDigests ??
          APPROVED_ARTIFACT_MEMBER_DIGESTS,
      ),
      approvedSetDigest:
        options.approvedArtifactSetDigest ?? APPROVED_ARTIFACT_SET_DIGEST,
      expectedApprovedCount,
    },
    failureGates,
  );
  const agentExecutionPlans = classifyAgentExecutionPlans(
    inventory.identity,
    inventory.agentExecutionPlans,
    expectedRuntimeConsumers,
    observedRuntimeConsumers,
    failureGates,
  );
  const versions = classifyVersions(inventory.versions, failureGates);
  const heads = classifyHeads(inventory.heads);
  const headHashSet = new Set(heads.distinctHashes);
  const runs = classifyRuns(inventory.runs, headHashSet, failureGates);
  const checkpoints = classifyCheckpoints(
    inventory.checkpoints,
    new Set(
      inventory.versions.map((version) => {
        return version.id;
      }),
    ),
    new Set(runs.versionHashes),
    headHashSet,
    failureGates,
  );
  const danglingHeads = classifyDangling(
    inventory.danglingStart,
    inventory.danglingEnd,
    expectedDanglingCount,
    failureGates,
  );
  const dependencies = classifyDependencies(
    inventory.catalogDependencies,
    expectedCatalog,
    expectedRepository,
    observedRepository,
    failureGates,
  );
  const launchSnapshots = classifyLaunchSnapshotRecoverability({
    runs: inventory.runs,
    versions: inventory.versions,
    checkpoints: inventory.checkpoints,
    conversations: inventory.conversations,
  });
  for (const gate of launchSnapshots.failureGates) failureGates.add(gate);
  const sortedFailureGates = [...failureGates].sort();

  const result = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    status:
      sortedFailureGates.length === 0
        ? ("passed" as const)
        : ("failed" as const),
    failureGates: sortedFailureGates,
    capabilities,
    agentExecutionPlans,
    identity,
    versions,
    heads: heads.output,
    runs: runs.output,
    checkpoints,
    danglingHeads,
    dependencies,
    launchSnapshots: launchSnapshots.output,
  };
  assertPreflightOutputShape(result);
  return result;
}

const DANGLING_QUERY = `
SELECT
  "compose"."id"::text AS "composeId",
  "compose"."head_version_id" AS "recordedHash",
  "agent"."name" AS "agentName"
FROM "agent_composes" AS "compose"
LEFT JOIN "agent_compose_versions" AS "version"
  ON "version"."id" = "compose"."head_version_id"
LEFT JOIN "zero_agents" AS "agent" ON "agent"."id" = "compose"."id"
WHERE "compose"."head_version_id" IS NOT NULL
  AND "version"."id" IS NULL
ORDER BY "compose"."id"
`;

async function collectDatabaseInventory(
  client: Client,
  signal: AbortSignal | undefined,
): Promise<PreflightInventory> {
  const danglingStart = await safeQuery<DanglingInventoryRow>(
    client,
    signal,
    DANGLING_QUERY,
  );
  const identity = await safeQuery<IdentityInventoryRow>(
    client,
    signal,
    `SELECT
       coalesce("compose"."id", "agent"."id")::text AS "id",
       "compose"."id" IS NOT NULL AS "composePresent",
       "agent"."id" IS NOT NULL AS "zeroPresent",
       coalesce("compose"."org_id" IS DISTINCT FROM "agent"."org_id", false)
         AS "orgMismatch",
       coalesce("compose"."user_id" IS DISTINCT FROM "agent"."owner", false)
         AS "ownerMismatch",
       coalesce("compose"."name" IS DISTINCT FROM "agent"."name", false)
         AS "nameMismatch",
       CASE
         WHEN "compose"."id" IS NULL OR "agent"."id" IS NULL THEN NULL
         WHEN "agent"."created_at" < "compose"."created_at" THEN 'zeroEarlier'
         WHEN "agent"."created_at" = "compose"."created_at" THEN 'equal'
         ELSE 'zeroLater'
       END AS "createdRelation",
       CASE
         WHEN "compose"."id" IS NULL OR "agent"."id" IS NULL THEN NULL
         WHEN "compose"."updated_at" > "agent"."updated_at" THEN 'compose'
         WHEN "compose"."updated_at" = "agent"."updated_at" THEN 'equal'
         ELSE 'zero'
       END AS "updatedSource"
     FROM "agent_composes" AS "compose"
     FULL OUTER JOIN "zero_agents" AS "agent"
       ON "agent"."id" = "compose"."id"
     ORDER BY coalesce("compose"."id", "agent"."id")`,
  );
  const agentExecutionPlans = await safeQuery<AgentExecutionPlanInventoryRow>(
    client,
    signal,
    `WITH "attributedRunActivity" AS (
       SELECT
         "session"."agent_compose_id" AS "agentComposeId",
         "session"."org_id" AS "orgId",
         max("run"."created_at") AT TIME ZONE current_setting('TimeZone')
           AS "latestAttributedRunAt",
         coalesce(
           bool_or("run"."status" = ANY($1::text[])),
           false
         ) AS "activeNonterminalRun",
         coalesce(
           bool_or(
             "run"."agent_compose_version_id" = "ownedCompose"."head_version_id"
           ),
           false
         ) AS "currentHeadEverExercised",
         coalesce(
           bool_or(NOT ("run"."status" = ANY($2::text[]))),
           false
         ) AS "unknownRunStatus"
       FROM "agent_sessions" AS "session"
       INNER JOIN "agent_runs" AS "run"
         ON "run"."session_id" = "session"."id"
       INNER JOIN "agent_composes" AS "ownedCompose"
         ON "ownedCompose"."id" = "session"."agent_compose_id"
        AND "ownedCompose"."org_id" = "session"."org_id"
        AND "ownedCompose"."org_id" = "run"."org_id"
       GROUP BY "session"."agent_compose_id", "session"."org_id"
     )
     SELECT
         "compose"."id"::text AS "id",
         "agent"."name" AS "agentName",
         "compose"."head_version_id" AS "headVersionId",
         "version"."id" AS "versionId",
         "version"."compose_id"::text AS "insertionComposeId",
         "version"."content",
         transaction_timestamp() AS "activitySnapshotTime",
         "activity"."latestAttributedRunAt",
         coalesce("activity"."activeNonterminalRun", false)
           AS "activeNonterminalRun",
         coalesce("activity"."currentHeadEverExercised", false)
           AS "currentHeadEverExercised",
         coalesce("activity"."unknownRunStatus", false)
           AS "unknownRunStatus"
       FROM "agent_composes" AS "compose"
       INNER JOIN "zero_agents" AS "agent"
         ON "agent"."id" = "compose"."id"
       LEFT JOIN "agent_compose_versions" AS "version"
         ON "version"."id" = "compose"."head_version_id"
       LEFT JOIN "attributedRunActivity" AS "activity"
         ON "activity"."agentComposeId" = "compose"."id"
        AND "activity"."orgId" = "compose"."org_id"
       ORDER BY "compose"."id"`,
    [ACTIVE_RUN_STATUSES, ALL_RUN_STATUSES],
  );
  const versions = await safeQuery<VersionInventoryRow>(
    client,
    signal,
    `SELECT
       "version"."id",
       "version"."compose_id"::text AS "composeId",
       "compose"."id" IS NOT NULL AS "composeExists",
       "version"."created_by" IS NOT NULL AS "creatorPresent",
       "version"."content"
     FROM "agent_compose_versions" AS "version"
     LEFT JOIN "agent_composes" AS "compose"
       ON "compose"."id" = "version"."compose_id"
     ORDER BY "version"."id"`,
  );
  const heads = await safeQuery<HeadInventoryRow>(
    client,
    signal,
    `SELECT
       "compose"."id"::text AS "composeId",
       "compose"."head_version_id" AS "headVersionId",
       "version"."id" IS NOT NULL AS "versionPresent",
       "version"."compose_id"::text AS "insertionComposeId"
     FROM "agent_composes" AS "compose"
     LEFT JOIN "agent_compose_versions" AS "version"
       ON "version"."id" = "compose"."head_version_id"
     WHERE "compose"."head_version_id" IS NOT NULL
     ORDER BY "compose"."id"`,
  );
  const runs = await safeQuery<RunInventoryRow>(
    client,
    signal,
    `SELECT
       "run"."id"::text AS "id",
       "run"."agent_compose_version_id" AS "versionId",
       "version"."id" IS NOT NULL AS "versionPresent",
       "run"."created_at" AT TIME ZONE 'UTC' AS "createdAt",
       "run"."launch_snapshot" AS "launchSnapshot",
       "run"."model_provider" AS "modelProvider",
       "run"."selected_model" AS "selectedModel",
       "run"."trigger_source" AS "triggerSource",
       CASE
         WHEN
           "run"."trigger_source" IS NULL AND
           "run"."autonomy_budget" IS NULL AND
           "run"."workflow_automation_id" IS NULL AND
           "run"."goal_id" IS NULL AND
           "run"."model_provider" IS NULL AND
           "run"."model_provider_id" IS NULL AND
           "run"."model_provider_credential_scope" IS NULL AND
           "run"."selected_model" IS NULL AND
           "run"."codex_service_tier" IS NULL AND
           "run"."selected_video_model" IS NULL AND
           "run"."selected_image_model" IS NULL AND
           "run"."chat_thread_id" IS NULL AND
           "run"."api_started_at" IS NULL AND
           "run"."first_assistant_event_acknowledged_at" IS NULL AND
           "run"."summary" IS NULL AND
           "run"."trigger_brief" IS NULL
           THEN 'lifecycle_only'
         WHEN
           "run"."trigger_source" IS NOT NULL AND
           "run"."autonomy_budget" IS NOT NULL
           THEN 'product'
         ELSE 'partial'
       END AS "metadataShape",
       "run"."chat_thread_id" IS NOT NULL AS "chatThreadPresent"
     FROM "agent_runs" AS "run"
     LEFT JOIN "agent_compose_versions" AS "version"
       ON "version"."id" = "run"."agent_compose_version_id"
     ORDER BY "run"."id"`,
  );
  const checkpoints = await safeQuery<CheckpointInventoryRow>(
    client,
    signal,
    `SELECT
       "checkpoint"."id"::text AS "id",
       "checkpoint"."run_id"::text AS "runId",
       "checkpoint"."agent_compose_snapshot" AS "snapshot"
     FROM "checkpoints" AS "checkpoint"
     ORDER BY "checkpoint"."id"`,
  );
  const conversations = await safeQuery<ConversationInventoryRow>(
    client,
    signal,
    `SELECT
       "conversation"."run_id"::text AS "runId",
       "conversation"."cli_agent_type" AS "framework"
     FROM "conversations" AS "conversation"
     ORDER BY "conversation"."run_id"`,
  );
  const catalogDependencies = await safeQuery<CatalogDependencyRow>(
    client,
    signal,
    CATALOG_DEPENDENCY_QUERY,
  );
  const danglingEnd = await safeQuery<DanglingInventoryRow>(
    client,
    signal,
    DANGLING_QUERY,
  );
  return {
    identity,
    versions,
    heads,
    runs,
    checkpoints,
    conversations,
    danglingStart,
    danglingEnd,
    agentExecutionPlans,
    catalogDependencies,
  };
}

export async function executeAgentComposeConsolidationPreflight(args: {
  readonly connectionString: string;
  readonly repositoryRoot: string;
  readonly signal?: AbortSignal;
  readonly classification?: PreflightClassificationOptions;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}) {
  let repositoryDependencies: RepositoryDependencyManifest;
  let runtimeContentConsumers: RuntimeContentConsumerManifest;
  try {
    [repositoryDependencies, runtimeContentConsumers] = await Promise.all([
      collectRepositoryDependencyManifest(args.repositoryRoot),
      collectRuntimeContentConsumerManifest(args.repositoryRoot),
    ]);
  } catch (error) {
    classifyThrownError(error, "probe.repository_inventory");
  }

  const client = new Client({ connectionString: args.connectionString });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    classifyThrownError(error, "probe.database_connection");
  }

  try {
    const snapshot = await withReadOnlySnapshot(
      client,
      {
        signal: args.signal,
        lockTimeoutMs: args.lockTimeoutMs,
        statementTimeoutMs: args.statementTimeoutMs,
      },
      async () => {
        return collectDatabaseInventory(client, args.signal);
      },
    );
    return classifyPreflightInventory(snapshot.capabilities, snapshot.value, {
      ...args.classification,
      observedRepositoryDependencies: repositoryDependencies,
      observedRuntimeContentConsumers: runtimeContentConsumers,
    });
  } catch (error) {
    classifyThrownError(error, "probe.inventory");
  } finally {
    await client.end().catch(() => {});
  }
}

export function sanitizedFailureResult(error: unknown): {
  readonly schemaVersion: string;
  readonly status: "failed";
  readonly failureGates: readonly string[];
} {
  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    status: "failed",
    failureGates: [
      error instanceof SanitizedPreflightError
        ? error.gate
        : "probe.unexpected",
    ],
  };
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stdout.write(
      `${JSON.stringify(sanitizedFailureResult(new SanitizedPreflightError("probe.configuration")))}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const abortController = new AbortController();
  const abort = (): void => {
    return abortController.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const result = await executeAgentComposeConsolidationPreflight({
      connectionString: databaseUrl,
      repositoryRoot,
      signal: abortController.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(sanitizedFailureResult(error))}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify(sanitizedFailureResult(error))}\n`);
    process.exitCode = 1;
  });
}
