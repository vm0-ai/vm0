#!/usr/bin/env tsx

import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Client, type QueryResultRow } from "pg";
import {
  fingerprintSortedSet,
  type SetFingerprint,
} from "./agent-compose-consolidation-preflight-fingerprint";
import {
  LAUNCH_SNAPSHOT_DISPOSITIONS,
  classifyLaunchSnapshotRecoverability,
  type ExactLaunchSnapshotValue,
  type LaunchSnapshotCheckpointInventoryRow,
  type LaunchSnapshotConversationInventoryRow,
  type LaunchSnapshotReason,
  type LaunchSnapshotRunClassification,
  type LaunchSnapshotRunInventoryRow,
  type LaunchSnapshotVersionInventoryRow,
} from "./agent-compose-consolidation-preflight-launch-snapshots";

export const LAUNCH_SNAPSHOT_BACKFILL_SCHEMA_VERSION =
  "vm0.agent-run-launch-snapshot-backfill.v1";
export const LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE = 500;
export const LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_CHOICES = [1, 20, 300] as const;
export const LAUNCH_SNAPSHOT_BACKFILL_APPLY_CONFIRMATION =
  "apply-agent-run-launch-snapshot-backfill";

const PRODUCTION_LOCK_TIMEOUT_MS = 1000;
const PRODUCTION_STATEMENT_TIMEOUT_MS = 30_000;
const FROZEN_HISTORICAL_UNKNOWN: SetFingerprint = {
  count: 2627,
  digest: "314360539273450908d01e647338c39ee30c12e131bcddf67c54023c57bad94c",
};
const FROZEN_INTEGRITY_CONFLICT: SetFingerprint = {
  count: 9,
  digest: "c74f9a7cbeba3d52589f7b7bfb569ca7ecc25b7fa00e4a88ab728df7d22e2159",
};

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "pending",
  "running",
]);
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);
const SUPPORTED_RUN_STATUSES: ReadonlySet<string> = new Set([
  ...ACTIVE_RUN_STATUSES,
  ...TERMINAL_RUN_STATUSES,
]);
const CRITICAL_REASONS: ReadonlySet<LaunchSnapshotReason> = new Set([
  "checkpoint_snapshot_malformed",
  "checkpoint_version_missing",
  "conversation_framework_invalid",
  "created_before_reviewed_history_boundary",
  "existing_snapshot_invalid",
  "legacy_content_hash_conflict",
  "legacy_content_invalid",
  "legacy_content_unsupported",
  "otherwise_unclassified_shape",
  "run_checkpoint_version_conflict",
  "run_version_missing",
  "runner_profile_invalid",
  "trigger_source_unrecognized",
]);

const FAILURE_GATES = [
  "none",
  "configuration",
  "input",
  "database.connection",
  "database.query",
  "transaction.cleanup",
  "inventory.shape",
  "inventory.closure",
  "inventory.classifier",
  "inventory.duplicate_evidence",
  "inventory.critical_reason",
  "inventory.active_null",
  "inventory.unsupported_status",
  "inventory.frozen_historical_unknown",
  "inventory.frozen_integrity_conflict",
  "batch.size",
  "batch.contention",
  "batch.drift",
  "batch.affected_rows",
  "batch.read_back",
  "proof.drift",
  "lock_timeout",
  "statement_timeout",
  "cancelled",
  "output.shape",
  "unexpected",
] as const;

export type LaunchSnapshotBackfillFailureGate = (typeof FAILURE_GATES)[number];
export type LaunchSnapshotBackfillMode = "dry-run" | "apply";
export type LaunchSnapshotBackfillStatus =
  | "dry-run"
  | "no-op"
  | "partial"
  | "complete"
  | "failed";

export interface LaunchSnapshotBackfillPolicy {
  readonly frozenHistoricalUnknown: SetFingerprint;
  readonly frozenIntegrityConflict: SetFingerprint;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export const PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY: LaunchSnapshotBackfillPolicy =
  {
    frozenHistoricalUnknown: FROZEN_HISTORICAL_UNKNOWN,
    frozenIntegrityConflict: FROZEN_INTEGRITY_CONFLICT,
    lockTimeoutMs: PRODUCTION_LOCK_TIMEOUT_MS,
    statementTimeoutMs: PRODUCTION_STATEMENT_TIMEOUT_MS,
  };

export interface LaunchSnapshotBackfillInput {
  readonly connectionString: string;
  readonly mode: LaunchSnapshotBackfillMode;
  readonly batchSize: number;
  readonly maxBatches: number;
  readonly applyConfirmation?: string;
  readonly signal?: AbortSignal;
}

export interface LaunchSnapshotBackfillRunInventoryRow extends LaunchSnapshotRunInventoryRow {
  readonly status: string;
}

export interface LaunchSnapshotBackfillInventory {
  readonly runs: readonly LaunchSnapshotBackfillRunInventoryRow[];
  readonly versions: readonly LaunchSnapshotVersionInventoryRow[];
  readonly checkpoints: readonly LaunchSnapshotCheckpointInventoryRow[];
  readonly conversations: readonly LaunchSnapshotConversationInventoryRow[];
}

export interface LaunchSnapshotBackfillCandidate {
  readonly runId: string;
  readonly snapshot: ExactLaunchSnapshotValue;
}

interface LaunchSnapshotBackfillInventorySummary {
  readonly total: number;
  readonly population: SetFingerprint;
  readonly dispositions: Readonly<
    Record<(typeof LAUNCH_SNAPSHOT_DISPOSITIONS)[number], SetFingerprint>
  >;
  readonly closures: "exact" | "drift";
  readonly frozenHistoricalUnknown: "exact" | "drift";
  readonly frozenIntegrityConflict: "exact" | "drift";
  readonly criticalReasons: SetFingerprint;
  readonly duplicateEvidence: SetFingerprint;
  readonly activeNull: SetFingerprint;
  readonly unsupportedStatus: SetFingerprint;
  readonly existingSnapshots: SetFingerprint;
}

export interface LaunchSnapshotBackfillOutput {
  readonly schemaVersion: typeof LAUNCH_SNAPSHOT_BACKFILL_SCHEMA_VERSION;
  readonly mode: LaunchSnapshotBackfillMode;
  readonly status: LaunchSnapshotBackfillStatus;
  readonly failureGate: LaunchSnapshotBackfillFailureGate;
  readonly parameters: {
    readonly batchSize: number;
    readonly maxBatches: number;
  };
  readonly progress: {
    readonly candidateRows: number;
    readonly attemptedBatches: number;
    readonly committedBatches: number;
    readonly committedRows: number;
  };
  readonly before: LaunchSnapshotBackfillInventorySummary;
  readonly after: LaunchSnapshotBackfillInventorySummary;
  readonly proof: "exact" | "drift" | "not_run";
}

export class SanitizedLaunchSnapshotBackfillError extends Error {
  readonly gate: LaunchSnapshotBackfillFailureGate;

  constructor(gate: LaunchSnapshotBackfillFailureGate) {
    super(gate);
    this.name = "SanitizedLaunchSnapshotBackfillError";
    this.gate = gate;
  }
}

interface LaunchSnapshotBackfillAnalysis {
  readonly inventory: LaunchSnapshotBackfillInventory;
  readonly classifications: readonly LaunchSnapshotRunClassification[];
  readonly candidates: readonly LaunchSnapshotBackfillCandidate[];
  readonly summary: LaunchSnapshotBackfillInventorySummary;
  readonly runById: ReadonlyMap<string, LaunchSnapshotBackfillRunInventoryRow>;
  readonly classificationById: ReadonlyMap<
    string,
    LaunchSnapshotRunClassification
  >;
  readonly failureGates: readonly string[];
}

interface RawRunInventoryRow extends QueryResultRow {
  readonly id: unknown;
  readonly versionId: unknown;
  readonly createdAt: unknown;
  readonly launchSnapshot: unknown;
  readonly modelProvider: unknown;
  readonly selectedModel: unknown;
  readonly triggerSource: unknown;
  readonly chatThreadPresent: unknown;
  readonly metadataShape: unknown;
  readonly status: unknown;
}

interface RawVersionInventoryRow extends QueryResultRow {
  readonly id: unknown;
  readonly content: unknown;
}

interface RawCheckpointInventoryRow extends QueryResultRow {
  readonly runId: unknown;
  readonly snapshot: unknown;
}

interface RawConversationInventoryRow extends QueryResultRow {
  readonly runId: unknown;
  readonly framework: unknown;
}

interface RawCapabilityRow extends QueryResultRow {
  readonly readOnly: unknown;
  readonly isolationLevel: unknown;
  readonly lockTimeoutMs: unknown;
  readonly statementTimeoutMs: unknown;
}

interface RawSnapshotRow extends QueryResultRow {
  readonly id: unknown;
  readonly launchSnapshot: unknown;
}

const RUN_INVENTORY_PROJECTION = `
  "run"."id"::text AS "id",
  "run"."agent_compose_version_id" AS "versionId",
  "run"."created_at" AT TIME ZONE 'UTC' AS "createdAt",
  "run"."launch_snapshot" AS "launchSnapshot",
  "run"."model_provider" AS "modelProvider",
  "run"."selected_model" AS "selectedModel",
  "run"."trigger_source" AS "triggerSource",
  "run"."chat_thread_id" IS NOT NULL AS "chatThreadPresent",
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
  "run"."status" AS "status"
`;

const ALL_RUNS_QUERY = `
SELECT ${RUN_INVENTORY_PROJECTION}
FROM "agent_runs" AS "run"
ORDER BY "run"."id"
`;

const TARGET_RUNS_QUERY = `
SELECT ${RUN_INVENTORY_PROJECTION}
FROM "agent_runs" AS "run"
WHERE "run"."id" = ANY($1::uuid[])
ORDER BY "run"."id"
`;

const LOCKED_TARGET_RUNS_QUERY = `
SELECT ${RUN_INVENTORY_PROJECTION}
FROM "agent_runs" AS "run"
WHERE "run"."id" = ANY($1::uuid[])
  AND "run"."launch_snapshot" IS NULL
ORDER BY "run"."id"
FOR UPDATE OF "run" SKIP LOCKED
`;

const ALL_VERSIONS_QUERY = `
SELECT "version"."id", "version"."content"
FROM "agent_compose_versions" AS "version"
ORDER BY "version"."id"
`;

const TARGET_VERSIONS_QUERY = `
SELECT "version"."id", "version"."content"
FROM "agent_compose_versions" AS "version"
WHERE "version"."id" IN (
  SELECT "run"."agent_compose_version_id"
  FROM "agent_runs" AS "run"
  WHERE "run"."id" = ANY($1::uuid[])
  UNION
  SELECT "checkpoint"."agent_compose_snapshot" ->> 'agentComposeVersionId'
  FROM "checkpoints" AS "checkpoint"
  WHERE "checkpoint"."run_id" = ANY($1::uuid[])
)
ORDER BY "version"."id"
`;

const ALL_CHECKPOINTS_QUERY = `
SELECT
  "checkpoint"."run_id"::text AS "runId",
  "checkpoint"."agent_compose_snapshot" AS "snapshot"
FROM "checkpoints" AS "checkpoint"
ORDER BY "checkpoint"."id"
`;

const TARGET_CHECKPOINTS_QUERY = `
SELECT
  "checkpoint"."run_id"::text AS "runId",
  "checkpoint"."agent_compose_snapshot" AS "snapshot"
FROM "checkpoints" AS "checkpoint"
WHERE "checkpoint"."run_id" = ANY($1::uuid[])
ORDER BY "checkpoint"."id"
`;

const ALL_CONVERSATIONS_QUERY = `
SELECT
  "conversation"."run_id"::text AS "runId",
  "conversation"."cli_agent_type" AS "framework"
FROM "conversations" AS "conversation"
ORDER BY "conversation"."run_id"
`;

const TARGET_CONVERSATIONS_QUERY = `
SELECT
  "conversation"."run_id"::text AS "runId",
  "conversation"."cli_agent_type" AS "framework"
FROM "conversations" AS "conversation"
WHERE "conversation"."run_id" = ANY($1::uuid[])
ORDER BY "conversation"."run_id"
`;

const UPDATE_SNAPSHOTS_QUERY = `
WITH "payload" AS (
  SELECT "value"."id", "value"."snapshot"
  FROM jsonb_to_recordset($1::jsonb)
    AS "value"("id" uuid, "snapshot" jsonb)
)
UPDATE "agent_runs" AS "run"
SET "launch_snapshot" = "payload"."snapshot"
FROM "payload"
WHERE "run"."id" = "payload"."id"
  AND "run"."launch_snapshot" IS NULL
RETURNING
  "run"."id"::text AS "id",
  "run"."launch_snapshot" AS "launchSnapshot"
`;

const READ_BACK_SNAPSHOTS_QUERY = `
SELECT
  "run"."id"::text AS "id",
  "run"."launch_snapshot" AS "launchSnapshot"
FROM "agent_runs" AS "run"
WHERE "run"."id" = ANY($1::uuid[])
ORDER BY "run"."id"
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.shape");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function parseRunInventoryRow(
  row: RawRunInventoryRow,
): LaunchSnapshotBackfillRunInventoryRow {
  if (
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    typeof row.chatThreadPresent !== "boolean" ||
    (row.metadataShape !== "lifecycle_only" &&
      row.metadataShape !== "product" &&
      row.metadataShape !== "partial")
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.shape");
  }
  return {
    id: requiredString(row.id),
    versionId: nullableString(row.versionId),
    createdAt: row.createdAt,
    launchSnapshot: row.launchSnapshot,
    modelProvider: nullableString(row.modelProvider),
    selectedModel: nullableString(row.selectedModel),
    triggerSource: nullableString(row.triggerSource),
    chatThreadPresent: row.chatThreadPresent,
    metadataShape: row.metadataShape,
    status: requiredString(row.status),
  };
}

function parseVersionInventoryRow(
  row: RawVersionInventoryRow,
): LaunchSnapshotVersionInventoryRow {
  return { id: requiredString(row.id), content: row.content };
}

function parseCheckpointInventoryRow(
  row: RawCheckpointInventoryRow,
): LaunchSnapshotCheckpointInventoryRow {
  return { runId: requiredString(row.runId), snapshot: row.snapshot };
}

function parseConversationInventoryRow(
  row: RawConversationInventoryRow,
): LaunchSnapshotConversationInventoryRow {
  return {
    runId: requiredString(row.runId),
    framework: requiredString(row.framework),
  };
}

function parseSnapshotRow(row: RawSnapshotRow): {
  readonly id: string;
  readonly launchSnapshot: unknown;
} {
  return { id: requiredString(row.id), launchSnapshot: row.launchSnapshot };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SanitizedLaunchSnapshotBackfillError("cancelled");
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "string") return error.code;
  return databaseErrorCode(error.cause);
}

function sanitizeError(
  error: unknown,
  fallback: LaunchSnapshotBackfillFailureGate,
  signal?: AbortSignal,
): SanitizedLaunchSnapshotBackfillError {
  if (error instanceof SanitizedLaunchSnapshotBackfillError) return error;
  if (signal?.aborted) {
    return new SanitizedLaunchSnapshotBackfillError("cancelled");
  }
  const code = databaseErrorCode(error);
  if (code === "57014") {
    return new SanitizedLaunchSnapshotBackfillError("statement_timeout");
  }
  if (code === "55P03") {
    return new SanitizedLaunchSnapshotBackfillError("lock_timeout");
  }
  if (code === "40001") {
    return new SanitizedLaunchSnapshotBackfillError("batch.drift");
  }
  if (
    code?.startsWith("08") ||
    code === "57P01" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  ) {
    return new SanitizedLaunchSnapshotBackfillError("database.connection");
  }
  return new SanitizedLaunchSnapshotBackfillError(fallback);
}

function fingerprintsEqual(
  left: SetFingerprint,
  right: SetFingerprint,
): boolean {
  return left.count === right.count && left.digest === right.digest;
}

function compareRunIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function framedSnapshotMember(runId: string, snapshot: unknown): string {
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.shape");
  }
  return `${Buffer.byteLength(runId, "utf8")}:${runId}|${Buffer.byteLength(serialized, "utf8")}:${serialized}`;
}

function allClosuresExact(
  output: ReturnType<typeof classifyLaunchSnapshotRecoverability>["output"],
): boolean {
  return [
    output.populationClosure,
    output.dispositionPartitionClosure,
    output.dispositionDisjointnessClosure,
    output.dispositionUnionClosure,
    output.reasonPartitionClosure,
    output.reasonUnionClosure,
    output.reasonCompatibilityClosure,
  ].every((closure) => {
    return closure.classification === "exact";
  });
}

export function validateLaunchSnapshotBackfillInput(
  input: Omit<LaunchSnapshotBackfillInput, "connectionString" | "signal">,
): void {
  if (
    (input.mode !== "dry-run" && input.mode !== "apply") ||
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE ||
    !LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_CHOICES.some((choice) => {
      return choice === input.maxBatches;
    }) ||
    (input.mode === "apply" &&
      input.applyConfirmation !== LAUNCH_SNAPSHOT_BACKFILL_APPLY_CONFIRMATION)
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("input");
  }
}

async function configureTransaction(
  client: Client,
  readOnly: boolean,
  policy: LaunchSnapshotBackfillPolicy,
): Promise<void> {
  await client.query(
    `SELECT
       set_config('lock_timeout', $1, true),
       set_config('statement_timeout', $2, true)`,
    [`${policy.lockTimeoutMs}ms`, `${policy.statementTimeoutMs}ms`],
  );
  const capabilityResult = await client.query<RawCapabilityRow>(`
    SELECT
      current_setting('transaction_read_only') = 'on' AS "readOnly",
      current_setting('transaction_isolation') AS "isolationLevel",
      (SELECT "setting"::integer FROM "pg_settings"
       WHERE "name" = 'lock_timeout') AS "lockTimeoutMs",
      (SELECT "setting"::integer FROM "pg_settings"
       WHERE "name" = 'statement_timeout') AS "statementTimeoutMs"
  `);
  const capability = capabilityResult.rows[0];
  if (
    !capability ||
    capability.readOnly !== readOnly ||
    capability.isolationLevel !== "repeatable read" ||
    capability.lockTimeoutMs !== policy.lockTimeoutMs ||
    capability.statementTimeoutMs !== policy.statementTimeoutMs
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("database.query");
  }
}

async function inTransaction<Value>(args: {
  readonly client: Client;
  readonly readOnly: boolean;
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly signal?: AbortSignal;
  readonly fallbackGate: LaunchSnapshotBackfillFailureGate;
  readonly body: () => Promise<Value>;
}): Promise<Value> {
  let started = false;
  try {
    assertNotAborted(args.signal);
    await args.client.query(
      args.readOnly
        ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        : "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    );
    started = true;
    await configureTransaction(args.client, args.readOnly, args.policy);
    const value = await args.body();
    assertNotAborted(args.signal);
    await args.client.query(args.readOnly ? "ROLLBACK" : "COMMIT");
    started = false;
    return value;
  } catch (error) {
    if (started) {
      try {
        await args.client.query("ROLLBACK");
      } catch {
        throw sanitizeError(error, "transaction.cleanup", args.signal);
      }
    }
    throw sanitizeError(error, args.fallbackGate, args.signal);
  }
}

async function queryRuns(
  client: Client,
  query: string,
  signal: AbortSignal | undefined,
  runIds?: readonly string[],
): Promise<readonly LaunchSnapshotBackfillRunInventoryRow[]> {
  assertNotAborted(signal);
  const result = await client.query<RawRunInventoryRow>(
    query,
    runIds ? [[...runIds]] : undefined,
  );
  assertNotAborted(signal);
  return result.rows.map(parseRunInventoryRow);
}

async function queryVersions(
  client: Client,
  signal: AbortSignal | undefined,
  runIds?: readonly string[],
): Promise<readonly LaunchSnapshotVersionInventoryRow[]> {
  assertNotAborted(signal);
  const result = await client.query<RawVersionInventoryRow>(
    runIds ? TARGET_VERSIONS_QUERY : ALL_VERSIONS_QUERY,
    runIds ? [[...runIds]] : undefined,
  );
  assertNotAborted(signal);
  return result.rows.map(parseVersionInventoryRow);
}

async function queryCheckpoints(
  client: Client,
  signal: AbortSignal | undefined,
  runIds?: readonly string[],
): Promise<readonly LaunchSnapshotCheckpointInventoryRow[]> {
  assertNotAborted(signal);
  const result = await client.query<RawCheckpointInventoryRow>(
    runIds ? TARGET_CHECKPOINTS_QUERY : ALL_CHECKPOINTS_QUERY,
    runIds ? [[...runIds]] : undefined,
  );
  assertNotAborted(signal);
  return result.rows.map(parseCheckpointInventoryRow);
}

async function queryConversations(
  client: Client,
  signal: AbortSignal | undefined,
  runIds?: readonly string[],
): Promise<readonly LaunchSnapshotConversationInventoryRow[]> {
  assertNotAborted(signal);
  const result = await client.query<RawConversationInventoryRow>(
    runIds ? TARGET_CONVERSATIONS_QUERY : ALL_CONVERSATIONS_QUERY,
    runIds ? [[...runIds]] : undefined,
  );
  assertNotAborted(signal);
  return result.rows.map(parseConversationInventoryRow);
}

export async function collectLaunchSnapshotBackfillInventory(args: {
  readonly client: Client;
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly signal?: AbortSignal;
}): Promise<LaunchSnapshotBackfillInventory> {
  return inTransaction({
    client: args.client,
    readOnly: true,
    policy: args.policy,
    signal: args.signal,
    fallbackGate: "database.query",
    body: async () => {
      const runs = await queryRuns(args.client, ALL_RUNS_QUERY, args.signal);
      const versions = await queryVersions(args.client, args.signal);
      const checkpoints = await queryCheckpoints(args.client, args.signal);
      const conversations = await queryConversations(args.client, args.signal);
      return { runs, versions, checkpoints, conversations };
    },
  });
}

function matchingRunFingerprint(
  domain: string,
  runs: readonly LaunchSnapshotBackfillRunInventoryRow[],
  predicate: (run: LaunchSnapshotBackfillRunInventoryRow) => boolean,
): SetFingerprint {
  return fingerprintSortedSet(
    domain,
    runs.filter(predicate).map((run) => {
      return run.id;
    }),
  );
}

function summarizeLaunchSnapshotBackfillInventory(args: {
  readonly classified: ReturnType<typeof classifyLaunchSnapshotRecoverability>;
  readonly inventory: LaunchSnapshotBackfillInventory;
  readonly policy: LaunchSnapshotBackfillPolicy;
}): LaunchSnapshotBackfillInventorySummary {
  const criticalRunIds = args.classified.classifications
    .filter((classification) => {
      return [...classification.reasons].some((reason) => {
        return CRITICAL_REASONS.has(reason);
      });
    })
    .map((classification) => {
      return classification.runId;
    });
  const duplicateEvidenceMembers = [
    ...duplicateMembers(
      args.inventory.versions.map((version) => {
        return version.id;
      }),
    ).map((versionId) => {
      return `version:${versionId}`;
    }),
    ...duplicateMembers(
      args.inventory.checkpoints.map((checkpoint) => {
        return checkpoint.runId;
      }),
    ).map((runId) => {
      return `checkpoint:${runId}`;
    }),
    ...duplicateMembers(
      args.inventory.conversations.map((conversation) => {
        return conversation.runId;
      }),
    ).map((runId) => {
      return `conversation:${runId}`;
    }),
  ];
  const existingSnapshotMembers = args.inventory.runs
    .filter((run) => {
      return run.launchSnapshot !== null;
    })
    .map((run) => {
      return framedSnapshotMember(run.id, run.launchSnapshot);
    });
  return {
    total: args.classified.output.total,
    population: args.classified.output.population,
    dispositions: args.classified.output.dispositions,
    closures: allClosuresExact(args.classified.output) ? "exact" : "drift",
    frozenHistoricalUnknown: fingerprintsEqual(
      args.classified.output.dispositions.historical_unknown,
      args.policy.frozenHistoricalUnknown,
    )
      ? "exact"
      : "drift",
    frozenIntegrityConflict: fingerprintsEqual(
      args.classified.output.dispositions.integrity_conflict,
      args.policy.frozenIntegrityConflict,
    )
      ? "exact"
      : "drift",
    criticalReasons: fingerprintSortedSet(
      "launch-snapshot-backfill:critical-reason-run-ids:v1",
      criticalRunIds,
    ),
    duplicateEvidence: fingerprintSortedSet(
      "launch-snapshot-backfill:duplicate-evidence:v1",
      duplicateEvidenceMembers,
    ),
    activeNull: matchingRunFingerprint(
      "launch-snapshot-backfill:active-null-run-ids:v1",
      args.inventory.runs,
      (run) => {
        return (
          run.launchSnapshot === null && ACTIVE_RUN_STATUSES.has(run.status)
        );
      },
    ),
    unsupportedStatus: matchingRunFingerprint(
      "launch-snapshot-backfill:unsupported-status-run-ids:v1",
      args.inventory.runs,
      (run) => {
        return !SUPPORTED_RUN_STATUSES.has(run.status);
      },
    ),
    existingSnapshots: fingerprintSortedSet(
      "launch-snapshot-backfill:existing-snapshots:v1",
      existingSnapshotMembers,
    ),
  };
}

export function analyzeLaunchSnapshotBackfillInventory(
  inventory: LaunchSnapshotBackfillInventory,
  policy: LaunchSnapshotBackfillPolicy,
): LaunchSnapshotBackfillAnalysis {
  const classified = classifyLaunchSnapshotRecoverability(inventory);
  const runById = new Map(
    inventory.runs.map((run) => {
      return [run.id, run] as const;
    }),
  );
  const classificationById = new Map(
    classified.classifications.map((classification) => {
      return [classification.runId, classification] as const;
    }),
  );
  const summary = summarizeLaunchSnapshotBackfillInventory({
    classified,
    inventory,
    policy,
  });
  const candidates = classified.classifications
    .flatMap((classification): readonly LaunchSnapshotBackfillCandidate[] => {
      return classification.disposition === "exactly_recoverable"
        ? [{ runId: classification.runId, snapshot: classification.snapshot }]
        : [];
    })
    .sort((left, right) => {
      return compareRunIds(left.runId, right.runId);
    });
  return {
    inventory,
    classifications: classified.classifications,
    candidates,
    summary,
    runById,
    classificationById,
    failureGates: classified.failureGates,
  };
}

function duplicateMembers(values: readonly string[]): string[] {
  const observed = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (observed.has(value)) duplicates.add(value);
    observed.add(value);
  }
  return [...duplicates];
}

export function assertLaunchSnapshotBackfillInventorySafe(
  analysis: LaunchSnapshotBackfillAnalysis,
): void {
  if (analysis.summary.closures !== "exact") {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.closure");
  }
  if (
    analysis.failureGates.some((gate) => {
      return gate !== "launchSnapshots.integrity_conflict";
    })
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.classifier");
  }
  if (analysis.summary.duplicateEvidence.count !== 0) {
    throw new SanitizedLaunchSnapshotBackfillError(
      "inventory.duplicate_evidence",
    );
  }
  if (analysis.summary.frozenHistoricalUnknown !== "exact") {
    throw new SanitizedLaunchSnapshotBackfillError(
      "inventory.frozen_historical_unknown",
    );
  }
  if (analysis.summary.frozenIntegrityConflict !== "exact") {
    throw new SanitizedLaunchSnapshotBackfillError(
      "inventory.frozen_integrity_conflict",
    );
  }
  if (analysis.summary.criticalReasons.count !== 0) {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.critical_reason");
  }
  if (analysis.summary.activeNull.count !== 0) {
    throw new SanitizedLaunchSnapshotBackfillError("inventory.active_null");
  }
  if (analysis.summary.unsupportedStatus.count !== 0) {
    throw new SanitizedLaunchSnapshotBackfillError(
      "inventory.unsupported_status",
    );
  }
  for (const candidate of analysis.candidates) {
    const run = analysis.runById.get(candidate.runId);
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new SanitizedLaunchSnapshotBackfillError("inventory.active_null");
    }
  }
}

function sameRunIds(
  rows: readonly { readonly id: string }[],
  expected: readonly string[],
): boolean {
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      return row.id === expected[index];
    })
  );
}

function exactClassification(
  classifications: readonly LaunchSnapshotRunClassification[],
  runId: string,
): LaunchSnapshotRunClassification | undefined {
  return classifications.find((classification) => {
    return classification.runId === runId;
  });
}

async function reproveLaunchSnapshotBackfillBatch(args: {
  readonly candidateIds: readonly string[];
  readonly candidates: readonly LaunchSnapshotBackfillCandidate[];
  readonly client: Client;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const lockedRuns = await queryRuns(
    args.client,
    LOCKED_TARGET_RUNS_QUERY,
    args.signal,
    args.candidateIds,
  );
  if (!sameRunIds(lockedRuns, args.candidateIds)) {
    const currentRuns = await queryRuns(
      args.client,
      TARGET_RUNS_QUERY,
      args.signal,
      args.candidateIds,
    );
    const currentById = new Map(
      currentRuns.map((run) => {
        return [run.id, run] as const;
      }),
    );
    const contentionOnly = args.candidateIds.every((runId) => {
      return currentById.get(runId)?.launchSnapshot === null;
    });
    throw new SanitizedLaunchSnapshotBackfillError(
      contentionOnly ? "batch.contention" : "batch.drift",
    );
  }

  const versions = await queryVersions(
    args.client,
    args.signal,
    args.candidateIds,
  );
  const checkpoints = await queryCheckpoints(
    args.client,
    args.signal,
    args.candidateIds,
  );
  const conversations = await queryConversations(
    args.client,
    args.signal,
    args.candidateIds,
  );
  const classified = classifyLaunchSnapshotRecoverability({
    runs: lockedRuns,
    versions,
    checkpoints,
    conversations,
  });
  if (
    !allClosuresExact(classified.output) ||
    classified.classifications.length !== args.candidates.length
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("batch.drift");
  }
  for (const candidate of args.candidates) {
    const run = lockedRuns.find((item) => {
      return item.id === candidate.runId;
    });
    const classification = exactClassification(
      classified.classifications,
      candidate.runId,
    );
    if (
      !run ||
      run.launchSnapshot !== null ||
      !TERMINAL_RUN_STATUSES.has(run.status) ||
      classification?.disposition !== "exactly_recoverable" ||
      !isDeepStrictEqual(classification.snapshot, candidate.snapshot)
    ) {
      throw new SanitizedLaunchSnapshotBackfillError("batch.drift");
    }
  }
}

async function writeAndReadBackLaunchSnapshots(args: {
  readonly candidateIds: readonly string[];
  readonly candidates: readonly LaunchSnapshotBackfillCandidate[];
  readonly client: Client;
}): Promise<void> {
  const payload = args.candidates.map((candidate) => {
    return { id: candidate.runId, snapshot: candidate.snapshot };
  });
  const update = await args.client.query<RawSnapshotRow>(
    UPDATE_SNAPSHOTS_QUERY,
    [JSON.stringify(payload)],
  );
  const updatedRows = update.rows.map(parseSnapshotRow).sort((left, right) => {
    return compareRunIds(left.id, right.id);
  });
  if (
    update.rowCount !== args.candidates.length ||
    !sameRunIds(updatedRows, args.candidateIds)
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("batch.affected_rows");
  }
  assertSnapshotRowsMatch(updatedRows, args.candidates);

  const readBack = await args.client.query<RawSnapshotRow>(
    READ_BACK_SNAPSHOTS_QUERY,
    [[...args.candidateIds]],
  );
  const readBackRows = readBack.rows
    .map(parseSnapshotRow)
    .sort((left, right) => {
      return compareRunIds(left.id, right.id);
    });
  if (!sameRunIds(readBackRows, args.candidateIds)) {
    throw new SanitizedLaunchSnapshotBackfillError("batch.read_back");
  }
  assertSnapshotRowsMatch(readBackRows, args.candidates);
}

function assertSnapshotRowsMatch(
  rows: readonly { readonly launchSnapshot: unknown }[],
  candidates: readonly LaunchSnapshotBackfillCandidate[],
): void {
  for (const [index, row] of rows.entries()) {
    if (!isDeepStrictEqual(row.launchSnapshot, candidates[index]!.snapshot)) {
      throw new SanitizedLaunchSnapshotBackfillError("batch.read_back");
    }
  }
}

export async function applyLaunchSnapshotBackfillBatch(args: {
  readonly client: Client;
  readonly candidates: readonly LaunchSnapshotBackfillCandidate[];
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly signal?: AbortSignal;
}): Promise<number> {
  if (
    args.candidates.length < 1 ||
    args.candidates.length > LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("batch.size");
  }
  const candidates = [...args.candidates].sort((left, right) => {
    return compareRunIds(left.runId, right.runId);
  });
  const candidateIds = candidates.map((candidate) => {
    return candidate.runId;
  });

  return inTransaction({
    client: args.client,
    readOnly: false,
    policy: args.policy,
    signal: args.signal,
    fallbackGate: "database.query",
    body: async () => {
      await reproveLaunchSnapshotBackfillBatch({
        candidateIds,
        candidates,
        client: args.client,
        signal: args.signal,
      });
      await writeAndReadBackLaunchSnapshots({
        candidateIds,
        candidates,
        client: args.client,
      });
      return candidates.length;
    },
  });
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every((value) => {
      return right.has(value);
    })
  );
}

export function proveLaunchSnapshotBackfill(args: {
  readonly before: LaunchSnapshotBackfillAnalysis;
  readonly after: LaunchSnapshotBackfillAnalysis;
  readonly committed: ReadonlyMap<string, ExactLaunchSnapshotValue>;
}): void {
  assertLaunchSnapshotBackfillInventorySafe(args.after);
  const expectedRemaining = new Set(
    args.before.candidates
      .map((candidate) => {
        return candidate.runId;
      })
      .filter((runId) => {
        return !args.committed.has(runId);
      }),
  );
  const observedRemaining = new Set(
    args.after.candidates.map((candidate) => {
      return candidate.runId;
    }),
  );
  if (!setsEqual(expectedRemaining, observedRemaining)) {
    throw new SanitizedLaunchSnapshotBackfillError("proof.drift");
  }

  for (const [runId, snapshot] of args.committed) {
    const run = args.after.runById.get(runId);
    const classification = args.after.classificationById.get(runId);
    if (
      !run ||
      classification?.disposition !== "already_valid" ||
      !isDeepStrictEqual(run.launchSnapshot, snapshot)
    ) {
      throw new SanitizedLaunchSnapshotBackfillError("proof.drift");
    }
  }

  for (const run of args.before.inventory.runs) {
    if (run.launchSnapshot === null) continue;
    const after = args.after.runById.get(run.id);
    if (
      !after ||
      !isDeepStrictEqual(after.launchSnapshot, run.launchSnapshot)
    ) {
      throw new SanitizedLaunchSnapshotBackfillError("proof.drift");
    }
  }
}

function emptySummary(
  policy: LaunchSnapshotBackfillPolicy,
): LaunchSnapshotBackfillInventorySummary {
  const dispositions = Object.fromEntries(
    LAUNCH_SNAPSHOT_DISPOSITIONS.map((disposition) => {
      return [
        disposition,
        fingerprintSortedSet(
          `launch-snapshot-backfill:empty:${disposition}:v1`,
          [],
        ),
      ];
    }),
  ) as Record<(typeof LAUNCH_SNAPSHOT_DISPOSITIONS)[number], SetFingerprint>;
  return {
    total: 0,
    population: fingerprintSortedSet(
      "launch-snapshot-backfill:empty:population:v1",
      [],
    ),
    dispositions,
    closures: "drift",
    frozenHistoricalUnknown: fingerprintsEqual(
      dispositions.historical_unknown,
      policy.frozenHistoricalUnknown,
    )
      ? "exact"
      : "drift",
    frozenIntegrityConflict: fingerprintsEqual(
      dispositions.integrity_conflict,
      policy.frozenIntegrityConflict,
    )
      ? "exact"
      : "drift",
    criticalReasons: fingerprintSortedSet(
      "launch-snapshot-backfill:empty:critical:v1",
      [],
    ),
    duplicateEvidence: fingerprintSortedSet(
      "launch-snapshot-backfill:empty:duplicate-evidence:v1",
      [],
    ),
    activeNull: fingerprintSortedSet(
      "launch-snapshot-backfill:empty:active-null:v1",
      [],
    ),
    unsupportedStatus: fingerprintSortedSet(
      "launch-snapshot-backfill:empty:unsupported-status:v1",
      [],
    ),
    existingSnapshots: fingerprintSortedSet(
      "launch-snapshot-backfill:empty:existing-snapshots:v1",
      [],
    ),
  };
}

function safeOutputInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function buildOutput(args: {
  readonly input: Pick<
    LaunchSnapshotBackfillInput,
    "mode" | "batchSize" | "maxBatches"
  >;
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly status: LaunchSnapshotBackfillStatus;
  readonly failureGate: LaunchSnapshotBackfillFailureGate;
  readonly candidateRows: number;
  readonly attemptedBatches: number;
  readonly committedBatches: number;
  readonly committedRows: number;
  readonly before?: LaunchSnapshotBackfillInventorySummary;
  readonly after?: LaunchSnapshotBackfillInventorySummary;
  readonly proof: "exact" | "drift" | "not_run";
}): LaunchSnapshotBackfillOutput {
  const empty = emptySummary(args.policy);
  return {
    schemaVersion: LAUNCH_SNAPSHOT_BACKFILL_SCHEMA_VERSION,
    mode: args.input.mode,
    status: args.status,
    failureGate: args.failureGate,
    parameters: {
      batchSize: safeOutputInteger(args.input.batchSize),
      maxBatches: safeOutputInteger(args.input.maxBatches),
    },
    progress: {
      candidateRows: safeOutputInteger(args.candidateRows),
      attemptedBatches: safeOutputInteger(args.attemptedBatches),
      committedBatches: safeOutputInteger(args.committedBatches),
      committedRows: safeOutputInteger(args.committedRows),
    },
    before: args.before ?? empty,
    after: args.after ?? empty,
    proof: args.proof,
  };
}

function summaryOutputPaths(prefix: string): string[] {
  return [
    `${prefix}.total`,
    `${prefix}.population.count`,
    `${prefix}.population.digest`,
    ...LAUNCH_SNAPSHOT_DISPOSITIONS.flatMap((disposition) => {
      return [
        `${prefix}.dispositions.${disposition}.count`,
        `${prefix}.dispositions.${disposition}.digest`,
      ];
    }),
    `${prefix}.closures`,
    `${prefix}.frozenHistoricalUnknown`,
    `${prefix}.frozenIntegrityConflict`,
    `${prefix}.criticalReasons.count`,
    `${prefix}.criticalReasons.digest`,
    `${prefix}.duplicateEvidence.count`,
    `${prefix}.duplicateEvidence.digest`,
    `${prefix}.activeNull.count`,
    `${prefix}.activeNull.digest`,
    `${prefix}.unsupportedStatus.count`,
    `${prefix}.unsupportedStatus.digest`,
    `${prefix}.existingSnapshots.count`,
    `${prefix}.existingSnapshots.digest`,
  ];
}

export const LAUNCH_SNAPSHOT_BACKFILL_OUTPUT_ALLOWLIST = [
  "schemaVersion",
  "mode",
  "status",
  "failureGate",
  "parameters.batchSize",
  "parameters.maxBatches",
  "progress.candidateRows",
  "progress.attemptedBatches",
  "progress.committedBatches",
  "progress.committedRows",
  ...summaryOutputPaths("before"),
  ...summaryOutputPaths("after"),
  "proof",
].sort();

function outputPaths(value: unknown, prefix = ""): string[] {
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .flatMap(([key, child]) => {
        return outputPaths(child, prefix ? `${prefix}.${key}` : key);
      })
      .sort();
  }
  return [prefix];
}

const SAFE_OUTPUT_STRINGS: ReadonlySet<string> = new Set([
  LAUNCH_SNAPSHOT_BACKFILL_SCHEMA_VERSION,
  "dry-run",
  "apply",
  "no-op",
  "partial",
  "complete",
  "failed",
  "exact",
  "drift",
  "not_run",
  ...FAILURE_GATES,
]);

function hasSafeOutputValues(value: unknown, prefix = ""): boolean {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, child]) => {
      return hasSafeOutputValues(child, prefix ? `${prefix}.${key}` : key);
    });
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value !== "string") return false;
  if (prefix.endsWith(".digest")) return /^[0-9a-f]{64}$/u.test(value);
  return SAFE_OUTPUT_STRINGS.has(value);
}

export function assertLaunchSnapshotBackfillOutputShape(value: unknown): void {
  const paths = outputPaths(value);
  if (
    paths.length !== LAUNCH_SNAPSHOT_BACKFILL_OUTPUT_ALLOWLIST.length ||
    !paths.every((path, index) => {
      return path === LAUNCH_SNAPSHOT_BACKFILL_OUTPUT_ALLOWLIST[index];
    }) ||
    !hasSafeOutputValues(value)
  ) {
    throw new SanitizedLaunchSnapshotBackfillError("output.shape");
  }
}

interface MutableLaunchSnapshotBackfillProgress {
  attemptedBatches: number;
  committedBatches: number;
  committedRows: number;
  readonly committed: Map<string, ExactLaunchSnapshotValue>;
}

interface MutableLaunchSnapshotBackfillExecution {
  after?: LaunchSnapshotBackfillAnalysis;
  before?: LaunchSnapshotBackfillAnalysis;
  candidateRows: number;
  proof: "exact" | "drift" | "not_run";
  readonly progress: MutableLaunchSnapshotBackfillProgress;
}

async function connectLaunchSnapshotBackfillClient(
  input: LaunchSnapshotBackfillInput,
): Promise<Client> {
  const client = new Client({ connectionString: input.connectionString });
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch (error) {
    throw sanitizeError(error, "database.connection", input.signal);
  }
}

async function applyDiscoveredLaunchSnapshotBatches(args: {
  readonly before: LaunchSnapshotBackfillAnalysis;
  readonly client: Client;
  readonly input: LaunchSnapshotBackfillInput;
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly progress: MutableLaunchSnapshotBackfillProgress;
}): Promise<void> {
  let offset = 0;
  while (
    offset < args.before.candidates.length &&
    args.progress.committedBatches < args.input.maxBatches
  ) {
    const batch = args.before.candidates.slice(
      offset,
      offset + args.input.batchSize,
    );
    args.progress.attemptedBatches++;
    const updated = await applyLaunchSnapshotBackfillBatch({
      client: args.client,
      candidates: batch,
      policy: args.policy,
      signal: args.input.signal,
    });
    args.progress.committedBatches++;
    args.progress.committedRows += updated;
    offset += updated;
    for (const candidate of batch) {
      args.progress.committed.set(candidate.runId, candidate.snapshot);
    }
  }
}

function completedApplyStatus(
  candidateRows: number,
  remainingCandidates: number,
): LaunchSnapshotBackfillStatus {
  if (candidateRows === 0) return "no-op";
  return remainingCandidates === 0 ? "complete" : "partial";
}

async function attemptLaunchSnapshotBackfillFailureProof(args: {
  readonly before: LaunchSnapshotBackfillAnalysis | undefined;
  readonly client: Client | undefined;
  readonly failureGate: LaunchSnapshotBackfillFailureGate;
  readonly input: LaunchSnapshotBackfillInput;
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly committed: ReadonlyMap<string, ExactLaunchSnapshotValue>;
}): Promise<{
  readonly after?: LaunchSnapshotBackfillAnalysis;
  readonly proof: "exact" | "drift" | "not_run";
}> {
  if (
    args.input.mode !== "apply" ||
    !args.client ||
    !args.before ||
    args.failureGate === "cancelled" ||
    args.failureGate === "database.connection"
  ) {
    return { proof: "not_run" };
  }
  let after: LaunchSnapshotBackfillAnalysis | undefined;
  try {
    const inventory = await collectLaunchSnapshotBackfillInventory({
      client: args.client,
      policy: args.policy,
    });
    after = analyzeLaunchSnapshotBackfillInventory(inventory, args.policy);
    proveLaunchSnapshotBackfill({
      before: args.before,
      after,
      committed: args.committed,
    });
    return { after, proof: "exact" };
  } catch {
    return { after, proof: "drift" };
  }
}

async function executeConnectedLaunchSnapshotBackfill(args: {
  readonly client: Client;
  readonly input: LaunchSnapshotBackfillInput;
  readonly policy: LaunchSnapshotBackfillPolicy;
  readonly state: MutableLaunchSnapshotBackfillExecution;
}): Promise<LaunchSnapshotBackfillOutput> {
  const beforeInventory = await collectLaunchSnapshotBackfillInventory({
    client: args.client,
    policy: args.policy,
    signal: args.input.signal,
  });
  const before = analyzeLaunchSnapshotBackfillInventory(
    beforeInventory,
    args.policy,
  );
  args.state.before = before;
  assertLaunchSnapshotBackfillInventorySafe(before);
  args.state.candidateRows = before.candidates.length;

  if (args.input.mode === "dry-run") {
    return buildOutput({
      input: args.input,
      policy: args.policy,
      status: args.state.candidateRows === 0 ? "no-op" : "dry-run",
      failureGate: "none",
      candidateRows: args.state.candidateRows,
      attemptedBatches: args.state.progress.attemptedBatches,
      committedBatches: args.state.progress.committedBatches,
      committedRows: args.state.progress.committedRows,
      before: before.summary,
      after: before.summary,
      proof: args.state.proof,
    });
  }

  await applyDiscoveredLaunchSnapshotBatches({
    before,
    client: args.client,
    input: args.input,
    policy: args.policy,
    progress: args.state.progress,
  });
  const afterInventory = await collectLaunchSnapshotBackfillInventory({
    client: args.client,
    policy: args.policy,
    signal: args.input.signal,
  });
  const after = analyzeLaunchSnapshotBackfillInventory(
    afterInventory,
    args.policy,
  );
  args.state.after = after;
  proveLaunchSnapshotBackfill({
    before,
    after,
    committed: args.state.progress.committed,
  });
  args.state.proof = "exact";
  return buildOutput({
    input: args.input,
    policy: args.policy,
    status: completedApplyStatus(
      args.state.candidateRows,
      after.candidates.length,
    ),
    failureGate: "none",
    candidateRows: args.state.candidateRows,
    attemptedBatches: args.state.progress.attemptedBatches,
    committedBatches: args.state.progress.committedBatches,
    committedRows: args.state.progress.committedRows,
    before: before.summary,
    after: after.summary,
    proof: args.state.proof,
  });
}

export async function executeLaunchSnapshotBackfill(
  input: LaunchSnapshotBackfillInput,
  policy: LaunchSnapshotBackfillPolicy = PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY,
): Promise<LaunchSnapshotBackfillOutput> {
  let client: Client | undefined;
  const state: MutableLaunchSnapshotBackfillExecution = {
    candidateRows: 0,
    proof: "not_run",
    progress: {
      attemptedBatches: 0,
      committedBatches: 0,
      committedRows: 0,
      committed: new Map(),
    },
  };

  try {
    validateLaunchSnapshotBackfillInput(input);
    if (!input.connectionString.trim()) {
      throw new SanitizedLaunchSnapshotBackfillError("configuration");
    }
    client = await connectLaunchSnapshotBackfillClient(input);
    const connectedClient = client;
    const cancelInFlight = (): void => {
      void connectedClient.end().catch(() => {});
    };
    input.signal?.addEventListener("abort", cancelInFlight, { once: true });
    if (input.signal?.aborted) cancelInFlight();
    try {
      const output = await executeConnectedLaunchSnapshotBackfill({
        client: connectedClient,
        input,
        policy,
        state,
      });
      assertLaunchSnapshotBackfillOutputShape(output);
      return output;
    } finally {
      input.signal?.removeEventListener("abort", cancelInFlight);
    }
  } catch (error) {
    const sanitized = sanitizeError(error, "unexpected", input.signal);
    const failureProof = await attemptLaunchSnapshotBackfillFailureProof({
      before: state.before,
      client,
      failureGate: sanitized.gate,
      input,
      policy,
      committed: state.progress.committed,
    });
    state.after = failureProof.after;
    state.proof = failureProof.proof;
    const output = buildOutput({
      input,
      policy,
      status: "failed",
      failureGate: sanitized.gate,
      candidateRows: state.candidateRows,
      attemptedBatches: state.progress.attemptedBatches,
      committedBatches: state.progress.committedBatches,
      committedRows: state.progress.committedRows,
      before: state.before?.summary,
      after: state.after?.summary,
      proof: state.proof,
    });
    assertLaunchSnapshotBackfillOutputShape(output);
    return output;
  } finally {
    await client?.end().catch(() => {});
  }
}

function parseIntegerInput(value: string | undefined): number {
  if (!value || !/^[0-9]+$/u.test(value)) {
    throw new SanitizedLaunchSnapshotBackfillError("input");
  }
  return Number(value);
}

function fallbackInput(): LaunchSnapshotBackfillInput {
  return {
    connectionString: "",
    mode: "dry-run",
    batchSize: LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE,
    maxBatches: 1,
  };
}

async function runCli(): Promise<void> {
  let input = fallbackInput();
  let output: LaunchSnapshotBackfillOutput;
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const timeout = setTimeout(abort, 55 * 60 * 1000);
  timeout.unref();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const { values } = parseArgs({
      options: {
        mode: { type: "string", default: "dry-run" },
        "batch-size": {
          type: "string",
          default: String(LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE),
        },
        "max-batches": { type: "string", default: "1" },
        "confirm-apply": { type: "string" },
      },
      strict: true,
    });
    if (values.mode !== "dry-run" && values.mode !== "apply") {
      throw new SanitizedLaunchSnapshotBackfillError("input");
    }
    input = {
      connectionString: process.env.DATABASE_URL ?? "",
      mode: values.mode,
      batchSize: parseIntegerInput(values["batch-size"]),
      maxBatches: parseIntegerInput(values["max-batches"]),
      applyConfirmation: values["confirm-apply"],
      signal: controller.signal,
    };
    output = await executeLaunchSnapshotBackfill(input);
  } catch (error) {
    const sanitized = sanitizeError(error, "unexpected");
    output = buildOutput({
      input,
      policy: PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY,
      status: "failed",
      failureGate: sanitized.gate,
      candidateRows: 0,
      attemptedBatches: 0,
      committedBatches: 0,
      committedRows: 0,
      proof: "not_run",
    });
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
  try {
    assertLaunchSnapshotBackfillOutputShape(output);
  } catch {
    output = buildOutput({
      input: fallbackInput(),
      policy: PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY,
      status: "failed",
      failureGate: "output.shape",
      candidateRows: 0,
      attemptedBatches: 0,
      committedBatches: 0,
      committedRows: 0,
      proof: "not_run",
    });
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === "failed") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    const output = buildOutput({
      input: fallbackInput(),
      policy: PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY,
      status: "failed",
      failureGate: "unexpected",
      candidateRows: 0,
      attemptedBatches: 0,
      committedBatches: 0,
      committedRows: 0,
      proof: "not_run",
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
  });
}
