#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { computeComposeVersionId } from "../../../apps/api/src/signals/services/agent-compose-content";
import {
  classifyLaunchSnapshotRecoverability,
  type ExactLaunchSnapshotValue,
} from "./agent-compose-consolidation-preflight-launch-snapshots";
import {
  LAUNCH_SNAPSHOT_BACKFILL_APPLY_CONFIRMATION,
  LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE,
  LAUNCH_SNAPSHOT_BACKFILL_OUTPUT_ALLOWLIST,
  PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY,
  SanitizedLaunchSnapshotBackfillError,
  analyzeLaunchSnapshotBackfillInventory,
  applyLaunchSnapshotBackfillBatch,
  assertLaunchSnapshotBackfillInventorySafe,
  assertLaunchSnapshotBackfillOutputShape,
  collectLaunchSnapshotBackfillInventory,
  executeLaunchSnapshotBackfill,
  proveLaunchSnapshotBackfill,
  validateLaunchSnapshotBackfillInput,
  type LaunchSnapshotBackfillInventory,
  type LaunchSnapshotBackfillPolicy,
} from "./agent-run-launch-snapshot-backfill";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const testSchema = "agent_run_launch_snapshot_backfill_test";
const applyConfirmation = LAUNCH_SNAPSHOT_BACKFILL_APPLY_CONFIRMATION;
const defaultSnapshot: ExactLaunchSnapshotValue = {
  schemaVersion: 1,
  framework: "claude-code",
  runnerProfile: "vm0/default",
};

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function agentContent(name: string): Record<string, unknown> {
  return {
    version: "1",
    agents: { [name]: { framework: "claude-code" } },
  };
}

function version(name: string): {
  readonly content: Record<string, unknown>;
  readonly id: string;
} {
  const content = agentContent(name);
  return { content, id: computeComposeVersionId(content) };
}

function inMemoryRun(args: {
  readonly id: string;
  readonly versionId: string | null;
  readonly launchSnapshot?: unknown;
  readonly status?: string;
}) {
  return {
    id: args.id,
    versionId: args.versionId,
    createdAt: new Date("2026-08-14T00:00:00.000Z"),
    launchSnapshot: args.launchSnapshot ?? null,
    modelProvider: "anthropic-api-key",
    selectedModel: null,
    triggerSource: "slack",
    chatThreadPresent: false,
    metadataShape: "product" as const,
    status: args.status ?? "completed",
  };
}

function policyForInventory(
  inventory: LaunchSnapshotBackfillInventory,
  timeouts: { readonly lock?: number; readonly statement?: number } = {},
): LaunchSnapshotBackfillPolicy {
  const classified = classifyLaunchSnapshotRecoverability(inventory);
  return {
    frozenHistoricalUnknown: classified.output.dispositions.historical_unknown,
    frozenIntegrityConflict: classified.output.dispositions.integrity_conflict,
    lockTimeoutMs:
      timeouts.lock ?? PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY.lockTimeoutMs,
    statementTimeoutMs:
      timeouts.statement ??
      PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY.statementTimeoutMs,
  };
}

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

function assertGate(
  action: () => unknown,
  gate: SanitizedLaunchSnapshotBackfillError["gate"],
): void {
  assert.throws(action, (error: unknown) => {
    return (
      error instanceof SanitizedLaunchSnapshotBackfillError &&
      error.gate === gate
    );
  });
}

async function assertRejectedGate(
  action: Promise<unknown>,
  gate: SanitizedLaunchSnapshotBackfillError["gate"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    return (
      error instanceof SanitizedLaunchSnapshotBackfillError &&
      error.gate === gate
    );
  });
}

function testBoundedInputs(): void {
  assert.deepEqual(
    PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY.frozenHistoricalUnknown,
    {
      count: 2627,
      digest:
        "314360539273450908d01e647338c39ee30c12e131bcddf67c54023c57bad94c",
    },
  );
  assert.deepEqual(
    PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY.frozenIntegrityConflict,
    {
      count: 9,
      digest:
        "c74f9a7cbeba3d52589f7b7bfb569ca7ecc25b7fa00e4a88ab728df7d22e2159",
    },
  );
  for (const batchSize of [1, 499, 500]) {
    validateLaunchSnapshotBackfillInput({
      mode: "dry-run",
      batchSize,
      maxBatches: 1,
    });
  }
  for (const batchSize of [0, 501]) {
    assertGate(() => {
      validateLaunchSnapshotBackfillInput({
        mode: "dry-run",
        batchSize,
        maxBatches: 1,
      });
    }, "input");
  }
  for (const maxBatches of [1, 20, 300]) {
    validateLaunchSnapshotBackfillInput({
      mode: "dry-run",
      batchSize: 500,
      maxBatches,
    });
  }
  assertGate(() => {
    validateLaunchSnapshotBackfillInput({
      mode: "dry-run",
      batchSize: 500,
      maxBatches: 2,
    });
  }, "input");
  assertGate(() => {
    validateLaunchSnapshotBackfillInput({
      mode: "unexpected" as "dry-run",
      batchSize: 500,
      maxBatches: 1,
    });
  }, "input");
  assertGate(() => {
    validateLaunchSnapshotBackfillInput({
      mode: "apply",
      batchSize: 500,
      maxBatches: 1,
    });
  }, "input");
  validateLaunchSnapshotBackfillInput({
    mode: "apply",
    batchSize: 500,
    maxBatches: 1,
    applyConfirmation,
  });
}

function testInventoryGatesAndConcurrentValidRows(): void {
  const storedVersion = version("inventory");
  const candidateId = uuid(1);
  const beforeInventory: LaunchSnapshotBackfillInventory = {
    runs: [
      inMemoryRun({ id: candidateId, versionId: storedVersion.id }),
      inMemoryRun({
        id: uuid(2),
        versionId: storedVersion.id,
        launchSnapshot: defaultSnapshot,
      }),
    ],
    versions: [storedVersion],
    checkpoints: [],
    conversations: [],
  };
  const policy = policyForInventory(beforeInventory);
  const before = analyzeLaunchSnapshotBackfillInventory(
    beforeInventory,
    policy,
  );
  assertLaunchSnapshotBackfillInventorySafe(before);
  assert.deepEqual(
    before.candidates.map((candidate) => {
      return candidate.runId;
    }),
    [candidateId],
  );

  const afterInventory: LaunchSnapshotBackfillInventory = {
    ...beforeInventory,
    runs: [
      inMemoryRun({
        id: candidateId,
        versionId: storedVersion.id,
        launchSnapshot: defaultSnapshot,
      }),
      beforeInventory.runs[1]!,
      inMemoryRun({
        id: uuid(3),
        versionId: storedVersion.id,
        launchSnapshot: defaultSnapshot,
      }),
    ],
  };
  const after = analyzeLaunchSnapshotBackfillInventory(afterInventory, policy);
  proveLaunchSnapshotBackfill({
    before,
    after,
    committed: new Map([[candidateId, defaultSnapshot]]),
  });
  assert.equal(after.summary.total, before.summary.total + 1);
  assert.equal(
    after.summary.dispositions.already_valid.count,
    before.summary.dispositions.already_valid.count + 2,
  );

  const unknownInventory: LaunchSnapshotBackfillInventory = {
    ...beforeInventory,
    runs: [
      ...beforeInventory.runs,
      inMemoryRun({ id: uuid(4), versionId: null }),
    ],
  };
  assertGate(() => {
    assertLaunchSnapshotBackfillInventorySafe(
      analyzeLaunchSnapshotBackfillInventory(unknownInventory, policy),
    );
  }, "inventory.frozen_historical_unknown");

  const conflictId = uuid(5);
  const conflictInventory: LaunchSnapshotBackfillInventory = {
    ...beforeInventory,
    runs: [
      ...beforeInventory.runs,
      inMemoryRun({ id: conflictId, versionId: storedVersion.id }),
    ],
    conversations: [{ runId: conflictId, framework: "codex" }],
  };
  assertGate(() => {
    assertLaunchSnapshotBackfillInventorySafe(
      analyzeLaunchSnapshotBackfillInventory(conflictInventory, policy),
    );
  }, "inventory.frozen_integrity_conflict");

  const activeInventory: LaunchSnapshotBackfillInventory = {
    ...beforeInventory,
    runs: [
      inMemoryRun({
        id: candidateId,
        versionId: storedVersion.id,
        status: "running",
      }),
      beforeInventory.runs[1]!,
    ],
  };
  assertGate(() => {
    assertLaunchSnapshotBackfillInventorySafe(
      analyzeLaunchSnapshotBackfillInventory(activeInventory, policy),
    );
  }, "inventory.active_null");

  const unsupportedStatusInventory: LaunchSnapshotBackfillInventory = {
    ...beforeInventory,
    runs: [
      inMemoryRun({
        id: candidateId,
        versionId: storedVersion.id,
        launchSnapshot: defaultSnapshot,
        status: "future-status",
      }),
      beforeInventory.runs[1]!,
    ],
  };
  assertGate(() => {
    assertLaunchSnapshotBackfillInventorySafe(
      analyzeLaunchSnapshotBackfillInventory(
        unsupportedStatusInventory,
        policy,
      ),
    );
  }, "inventory.unsupported_status");

  const duplicateInventory: LaunchSnapshotBackfillInventory = {
    ...beforeInventory,
    checkpoints: [
      { runId: candidateId, snapshot: null },
      { runId: candidateId, snapshot: null },
    ],
  };
  const duplicatePolicy = policyForInventory(duplicateInventory);
  assertGate(() => {
    assertLaunchSnapshotBackfillInventorySafe(
      analyzeLaunchSnapshotBackfillInventory(
        duplicateInventory,
        duplicatePolicy,
      ),
    );
  }, "inventory.duplicate_evidence");
}

async function testStaticSafetyContracts(): Promise<void> {
  const runner = await fs.readFile(
    path.join(dirname, "agent-run-launch-snapshot-backfill.ts"),
    "utf8",
  );

  assert.match(
    runner,
    /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u,
  );
  assert.match(runner, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ"/u);
  assert.match(runner, /FOR UPDATE OF "run" SKIP LOCKED/u);
  assert.match(
    runner,
    /UPDATE "agent_runs" AS "run"[\s\S]*?SET "launch_snapshot" = "payload"\."snapshot"[\s\S]*?AND "run"\."launch_snapshot" IS NULL/u,
  );
  assert.equal(runner.match(/UPDATE "agent_runs" AS "run"/gu)?.length, 1);
  assert.equal(/LOCK TABLE|pg_advisory/u.test(runner), false);
  assert.equal(
    /agent_composes|zero_agents|feature_switch/u.test(runner),
    false,
  );
  assert.equal(/console\.(?:log|error)|upload-artifact/u.test(runner), false);
  assert.match(runner, /const PRODUCTION_LOCK_TIMEOUT_MS = 1000/u);
  assert.match(runner, /const PRODUCTION_STATEMENT_TIMEOUT_MS = 30_000/u);
  assert.match(runner, /LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE = 500/u);
  assert.match(runner, /count: 2627/u);
  assert.match(
    runner,
    /314360539273450908d01e647338c39ee30c12e131bcddf67c54023c57bad94c/u,
  );
  assert.match(runner, /count: 9/u);
  assert.match(
    runner,
    /c74f9a7cbeba3d52589f7b7bfb569ca7ecc25b7fa00e4a88ab728df7d22e2159/u,
  );
}

async function testSanitizedConnectionFailure(): Promise<void> {
  const secret = "not-a-report-field";
  const output = await executeLaunchSnapshotBackfill({
    connectionString: `postgresql://127.0.0.1:1/${secret}`,
    mode: "dry-run",
    batchSize: 500,
    maxBatches: 1,
  });
  assert.equal(output.status, "failed");
  assert.equal(output.failureGate, "database.connection");
  assertLaunchSnapshotBackfillOutputShape(output);
  assert.deepEqual(
    outputPaths(output),
    LAUNCH_SNAPSHOT_BACKFILL_OUTPUT_ALLOWLIST,
  );
  assert.equal(JSON.stringify(output).includes(secret), false);
}

export async function validateLaunchSnapshotBackfillStatic(): Promise<void> {
  testBoundedInputs();
  testInventoryGatesAndConcurrentValidRows();
  await testStaticSafetyContracts();
  await testSanitizedConnectionFailure();
}

interface BaselineFixture {
  readonly candidateIds: readonly [string, string];
  readonly conflictId: string;
  readonly existingId: string;
  readonly existingSnapshot: ExactLaunchSnapshotValue;
  readonly unknownId: string;
}

function databaseUrlForSchema(databaseUrl: string): string {
  const result = new URL(databaseUrl);
  result.searchParams.set("options", `-c search_path=${testSchema}`);
  return result.toString();
}

async function createTestSchema(admin: Client): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${testSchema}"`);
  await admin.query(`
    CREATE TABLE "${testSchema}"."agent_runs" (
      "id" uuid PRIMARY KEY,
      "agent_compose_version_id" varchar(64),
      "created_at" timestamp NOT NULL,
      "launch_snapshot" jsonb,
      "model_provider" varchar(100),
      "selected_model" varchar(255),
      "trigger_source" varchar(20),
      "chat_thread_id" uuid,
      "autonomy_budget" integer,
      "workflow_automation_id" uuid,
      "goal_id" uuid,
      "model_provider_id" uuid,
      "model_provider_credential_scope" varchar(20),
      "codex_service_tier" varchar(20),
      "selected_video_model" varchar(255),
      "selected_image_model" varchar(255),
      "api_started_at" timestamp,
      "first_assistant_event_acknowledged_at" timestamp,
      "summary" text,
      "trigger_brief" text,
      "status" varchar(20) NOT NULL
    );
    CREATE TABLE "${testSchema}"."agent_compose_versions" (
      "id" varchar(64) NOT NULL,
      "content" jsonb
    );
    CREATE TABLE "${testSchema}"."checkpoints" (
      "id" uuid PRIMARY KEY,
      "run_id" uuid NOT NULL,
      "agent_compose_snapshot" jsonb
    );
    CREATE TABLE "${testSchema}"."conversations" (
      "run_id" uuid NOT NULL,
      "cli_agent_type" varchar(50) NOT NULL
    );
  `);
}

async function insertProductRun(
  client: Client,
  args: {
    readonly id: string;
    readonly versionId: string | null;
    readonly status?: string;
    readonly launchSnapshot?: ExactLaunchSnapshotValue | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "agent_runs" (
       "id", "agent_compose_version_id", "created_at", "launch_snapshot",
       "model_provider", "selected_model", "trigger_source",
       "autonomy_budget", "status"
     ) VALUES ($1, $2, '2026-08-14T00:00:00.000Z', $3::jsonb,
       'anthropic-api-key', NULL, 'slack', 5, $4)`,
    [
      args.id,
      args.versionId,
      args.launchSnapshot === undefined
        ? null
        : JSON.stringify(args.launchSnapshot),
      args.status ?? "completed",
    ],
  );
}

async function resetBaseline(client: Client): Promise<BaselineFixture> {
  await client.query(
    `TRUNCATE "conversations", "checkpoints", "agent_runs", "agent_compose_versions"`,
  );
  const firstVersion = version("database-first");
  const secondVersion = version("database-second");
  const conflictVersion = version("database-conflict");
  const existingVersion = version("database-existing");
  for (const storedVersion of [
    firstVersion,
    secondVersion,
    conflictVersion,
    existingVersion,
  ]) {
    await client.query(
      `INSERT INTO "agent_compose_versions" ("id", "content")
       VALUES ($1, $2::jsonb)`,
      [storedVersion.id, JSON.stringify(storedVersion.content)],
    );
  }

  const fixture: BaselineFixture = {
    candidateIds: [uuid(101), uuid(102)],
    unknownId: uuid(103),
    conflictId: uuid(104),
    existingId: uuid(105),
    existingSnapshot: {
      schemaVersion: 1,
      framework: "claude-code",
      runnerProfile: "vm0/existing",
    },
  };
  await insertProductRun(client, {
    id: fixture.candidateIds[1],
    versionId: secondVersion.id,
  });
  await insertProductRun(client, {
    id: fixture.candidateIds[0],
    versionId: firstVersion.id,
  });
  await insertProductRun(client, {
    id: fixture.unknownId,
    versionId: null,
  });
  await insertProductRun(client, {
    id: fixture.conflictId,
    versionId: conflictVersion.id,
  });
  await client.query(
    `INSERT INTO "conversations" ("run_id", "cli_agent_type")
     VALUES ($1, 'codex')`,
    [fixture.conflictId],
  );
  await insertProductRun(client, {
    id: fixture.existingId,
    versionId: existingVersion.id,
    launchSnapshot: fixture.existingSnapshot,
  });
  return fixture;
}

async function collectAnalysis(
  client: Client,
  policy: LaunchSnapshotBackfillPolicy,
) {
  const inventory = await collectLaunchSnapshotBackfillInventory({
    client,
    policy,
  });
  return analyzeLaunchSnapshotBackfillInventory(inventory, policy);
}

async function policyFromDatabase(
  client: Client,
  timeouts: { readonly lock?: number; readonly statement?: number } = {},
): Promise<LaunchSnapshotBackfillPolicy> {
  const inventory = await collectLaunchSnapshotBackfillInventory({
    client,
    policy: PRODUCTION_LAUNCH_SNAPSHOT_BACKFILL_POLICY,
  });
  return policyForInventory(inventory, timeouts);
}

async function snapshots(
  client: Client,
): Promise<ReadonlyMap<string, unknown>> {
  const result = await client.query<{
    readonly id: string;
    readonly launchSnapshot: unknown;
  }>(`
    SELECT "id"::text AS "id", "launch_snapshot" AS "launchSnapshot"
    FROM "agent_runs"
    ORDER BY "id"
  `);
  return new Map(
    result.rows.map((row) => {
      return [row.id, row.launchSnapshot] as const;
    }),
  );
}

async function testDryRunPartialRestartAndNoOp(args: {
  readonly client: Client;
  readonly connectionString: string;
}): Promise<void> {
  const fixture = await resetBaseline(args.client);
  const policy = await policyFromDatabase(args.client);
  const dryRun = await executeLaunchSnapshotBackfill(
    {
      connectionString: args.connectionString,
      mode: "dry-run",
      batchSize: 500,
      maxBatches: 1,
    },
    policy,
  );
  assert.equal(dryRun.status, "dry-run");
  assert.equal(dryRun.progress.candidateRows, 2);
  assert.equal(dryRun.progress.committedRows, 0);
  assert.equal(dryRun.before.frozenHistoricalUnknown, "exact");
  assert.equal(dryRun.before.frozenIntegrityConflict, "exact");

  const partial = await executeLaunchSnapshotBackfill(
    {
      connectionString: args.connectionString,
      mode: "apply",
      batchSize: 1,
      maxBatches: 1,
      applyConfirmation,
    },
    policy,
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.proof, "exact");
  assert.equal(partial.progress.committedRows, 1);
  const afterPartial = await snapshots(args.client);
  assert.deepEqual(afterPartial.get(fixture.candidateIds[0]), defaultSnapshot);
  assert.equal(afterPartial.get(fixture.candidateIds[1]), null);
  assert.equal(afterPartial.get(fixture.unknownId), null);
  assert.equal(afterPartial.get(fixture.conflictId), null);
  assert.deepEqual(
    afterPartial.get(fixture.existingId),
    fixture.existingSnapshot,
  );

  const restart = await executeLaunchSnapshotBackfill(
    {
      connectionString: args.connectionString,
      mode: "apply",
      batchSize: 500,
      maxBatches: 1,
      applyConfirmation,
    },
    policy,
  );
  assert.equal(restart.status, "complete");
  assert.equal(restart.progress.committedRows, 1);
  assert.equal(restart.proof, "exact");

  const beforeNoOp = await snapshots(args.client);
  const noOp = await executeLaunchSnapshotBackfill(
    {
      connectionString: args.connectionString,
      mode: "apply",
      batchSize: 500,
      maxBatches: 1,
      applyConfirmation,
    },
    policy,
  );
  assert.equal(noOp.status, "no-op");
  assert.equal(noOp.progress.committedRows, 0);
  assert.equal(noOp.proof, "exact");
  assert.deepEqual(await snapshots(args.client), beforeNoOp);
}

async function testDriftAndGuardedUpdate(client: Client): Promise<void> {
  const fixture = await resetBaseline(client);
  const policy = await policyFromDatabase(client);
  const before = await collectAnalysis(client, policy);
  assertLaunchSnapshotBackfillInventorySafe(before);
  const driftedCandidate = before.candidates.find((candidate) => {
    return candidate.runId === fixture.candidateIds[1];
  });
  assert.ok(driftedCandidate);
  const driftedRun = before.runById.get(driftedCandidate.runId);
  assert.ok(driftedRun?.versionId);
  await client.query(
    `UPDATE "agent_compose_versions"
     SET "content" = '{"version":"1","agents":{"changed":{"framework":"codex"}}}'::jsonb
     WHERE "id" = $1`,
    [driftedRun.versionId],
  );
  await assertRejectedGate(
    applyLaunchSnapshotBackfillBatch({
      client,
      candidates: before.candidates,
      policy,
    }),
    "batch.drift",
  );
  let observed = await snapshots(client);
  assert.equal(observed.get(fixture.candidateIds[0]), null);
  assert.equal(observed.get(fixture.candidateIds[1]), null);

  await resetBaseline(client);
  const guardedPolicy = await policyFromDatabase(client);
  const guardedBefore = await collectAnalysis(client, guardedPolicy);
  await client.query(
    `UPDATE "agent_runs" SET "launch_snapshot" = $2::jsonb WHERE "id" = $1`,
    [fixture.candidateIds[1], JSON.stringify(defaultSnapshot)],
  );
  await assertRejectedGate(
    applyLaunchSnapshotBackfillBatch({
      client,
      candidates: guardedBefore.candidates,
      policy: guardedPolicy,
    }),
    "batch.drift",
  );
  observed = await snapshots(client);
  assert.equal(observed.get(fixture.candidateIds[0]), null);
  assert.deepEqual(observed.get(fixture.candidateIds[1]), defaultSnapshot);
  assert.equal(observed.get(fixture.unknownId), null);
  assert.equal(observed.get(fixture.conflictId), null);
}

async function testContentionAndLockTimeout(args: {
  readonly client: Client;
  readonly connectionString: string;
}): Promise<void> {
  const fixture = await resetBaseline(args.client);
  const policy = await policyFromDatabase(args.client);
  const before = await collectAnalysis(args.client, policy);
  const blocker = new Client({ connectionString: args.connectionString });
  await blocker.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT "id" FROM "agent_runs" WHERE "id" = $1 FOR UPDATE`,
      [fixture.candidateIds[0]],
    );
    await assertRejectedGate(
      applyLaunchSnapshotBackfillBatch({
        client: args.client,
        candidates: before.candidates,
        policy,
      }),
      "batch.contention",
    );
    const observed = await snapshots(args.client);
    assert.equal(observed.get(fixture.candidateIds[0]), null);
    assert.equal(observed.get(fixture.candidateIds[1]), null);
    await blocker.query("ROLLBACK");

    await blocker.query("BEGIN");
    await blocker.query(`LOCK TABLE "agent_runs" IN ACCESS EXCLUSIVE MODE`);
    await assertRejectedGate(
      applyLaunchSnapshotBackfillBatch({
        client: args.client,
        candidates: before.candidates.slice(0, 1),
        policy: { ...policy, lockTimeoutMs: 50 },
      }),
      "lock_timeout",
    );
    await blocker.query("ROLLBACK");
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end();
  }
}

async function installUpdateTrigger(
  client: Client,
  body: string,
): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION "backfill_test_update"()
    RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      ${body}
    END
    $body$;
    CREATE TRIGGER "backfill_test_update"
    BEFORE UPDATE OF "launch_snapshot" ON "agent_runs"
    FOR EACH ROW EXECUTE FUNCTION "backfill_test_update"();
  `);
}

async function removeUpdateTrigger(client: Client): Promise<void> {
  await client.query(
    `DROP TRIGGER IF EXISTS "backfill_test_update" ON "agent_runs";
     DROP FUNCTION IF EXISTS "backfill_test_update"()`,
  );
}

async function testAffectedRowsAndReadBack(client: Client): Promise<void> {
  const fixture = await resetBaseline(client);
  const policy = await policyFromDatabase(client);
  const before = await collectAnalysis(client, policy);
  const candidate = before.candidates[0]!;

  await installUpdateTrigger(client, "RETURN NULL;");
  await assertRejectedGate(
    applyLaunchSnapshotBackfillBatch({
      client,
      candidates: [candidate],
      policy,
    }),
    "batch.affected_rows",
  );
  await removeUpdateTrigger(client);
  assert.equal((await snapshots(client)).get(fixture.candidateIds[0]), null);

  await installUpdateTrigger(
    client,
    `NEW."launch_snapshot" :=
       '{"schemaVersion":1,"framework":"codex","runnerProfile":"vm0/changed"}'::jsonb;
     RETURN NEW;`,
  );
  await assertRejectedGate(
    applyLaunchSnapshotBackfillBatch({
      client,
      candidates: [candidate],
      policy,
    }),
    "batch.read_back",
  );
  await removeUpdateTrigger(client);
  assert.equal((await snapshots(client)).get(fixture.candidateIds[0]), null);
}

async function testStatementTimeoutPreservesEarlierBatch(args: {
  readonly client: Client;
  readonly connectionString: string;
}): Promise<void> {
  const fixture = await resetBaseline(args.client);
  const policy = await policyFromDatabase(args.client, { statement: 50 });
  await installUpdateTrigger(
    args.client,
    `IF NEW."id" = '${fixture.candidateIds[1]}'::uuid THEN
       PERFORM pg_sleep(0.2);
     END IF;
     RETURN NEW;`,
  );
  const interrupted = await executeLaunchSnapshotBackfill(
    {
      connectionString: args.connectionString,
      mode: "apply",
      batchSize: 1,
      maxBatches: 20,
      applyConfirmation,
    },
    policy,
  );
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.failureGate, "statement_timeout");
  assert.equal(interrupted.progress.committedBatches, 1);
  assert.equal(interrupted.progress.committedRows, 1);
  assert.equal(interrupted.proof, "exact");
  let observed = await snapshots(args.client);
  assert.deepEqual(observed.get(fixture.candidateIds[0]), defaultSnapshot);
  assert.equal(observed.get(fixture.candidateIds[1]), null);

  await removeUpdateTrigger(args.client);
  const restarted = await executeLaunchSnapshotBackfill(
    {
      connectionString: args.connectionString,
      mode: "apply",
      batchSize: 500,
      maxBatches: 1,
      applyConfirmation,
    },
    { ...policy, statementTimeoutMs: 30_000 },
  );
  assert.equal(restarted.status, "complete");
  assert.equal(restarted.progress.committedRows, 1);
  observed = await snapshots(args.client);
  assert.deepEqual(observed.get(fixture.candidateIds[1]), defaultSnapshot);
}

async function testCancellationRollsBack(args: {
  readonly client: Client;
  readonly connectionString: string;
}): Promise<void> {
  const fixture = await resetBaseline(args.client);
  const policy = await policyFromDatabase(args.client);
  await installUpdateTrigger(args.client, "PERFORM pg_sleep(10); RETURN NEW;");
  const controller = new AbortController();
  const applicationName = "launch_snapshot_backfill_cancel_test";
  const cancellationUrl = new URL(args.connectionString);
  cancellationUrl.searchParams.set("application_name", applicationName);
  const execution = executeLaunchSnapshotBackfill(
    {
      connectionString: cancellationUrl.toString(),
      mode: "apply",
      batchSize: 2,
      maxBatches: 1,
      applyConfirmation,
      signal: controller.signal,
    },
    policy,
  );
  try {
    await waitForActiveBackfillUpdate(args.client, applicationName);
    controller.abort();
    const cancelled = await execution;
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.failureGate, "cancelled");
    assert.equal(cancelled.progress.committedRows, 0);
  } finally {
    controller.abort();
    await execution.catch(() => {});
    await removeUpdateTrigger(args.client);
  }
  const observed = await snapshots(args.client);
  assert.equal(observed.get(fixture.candidateIds[0]), null);
  assert.equal(observed.get(fixture.candidateIds[1]), null);
}

async function waitForActiveBackfillUpdate(
  client: Client,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const activity = await client.query<{ readonly active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM "pg_stat_activity"
         WHERE "application_name" = $1
           AND "state" = 'active'
           AND "query" LIKE '%UPDATE "agent_runs" AS "run"%'
       ) AS "active"`,
      [applicationName],
    );
    if (activity.rows[0]?.active) return;
  }
  throw new Error("backfill update did not become active");
}

async function testConnectionInterruptionRollsBack(args: {
  readonly client: Client;
  readonly connectionString: string;
}): Promise<void> {
  const fixture = await resetBaseline(args.client);
  const policy = await policyFromDatabase(args.client);
  await installUpdateTrigger(
    args.client,
    "PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW;",
  );
  try {
    const interrupted = await executeLaunchSnapshotBackfill(
      {
        connectionString: args.connectionString,
        mode: "apply",
        batchSize: 2,
        maxBatches: 1,
        applyConfirmation,
      },
      policy,
    );
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.failureGate, "database.connection");
    assert.equal(interrupted.progress.committedRows, 0);
  } finally {
    await removeUpdateTrigger(args.client);
  }
  const observed = await snapshots(args.client);
  assert.equal(observed.get(fixture.candidateIds[0]), null);
  assert.equal(observed.get(fixture.candidateIds[1]), null);
}

async function seedExactCandidates(
  client: Client,
  count: number,
): Promise<readonly string[]> {
  await client.query(
    `TRUNCATE "conversations", "checkpoints", "agent_runs", "agent_compose_versions"`,
  );
  const storedVersion = version(`batch-bound-${count}`);
  await client.query(
    `INSERT INTO "agent_compose_versions" ("id", "content")
     VALUES ($1, $2::jsonb)`,
    [storedVersion.id, JSON.stringify(storedVersion.content)],
  );
  const runIds = Array.from({ length: count }, (_, index) => {
    return uuid(2000 + index);
  });
  await client.query(
    `INSERT INTO "agent_runs" (
       "id", "agent_compose_version_id", "created_at", "launch_snapshot",
       "model_provider", "selected_model", "trigger_source",
       "autonomy_budget", "status"
     )
     SELECT "id", $2, '2026-08-14T00:00:00.000Z', NULL,
       'anthropic-api-key', NULL, 'slack', 5, 'completed'
     FROM unnest($1::uuid[]) AS "candidate"("id")`,
    [runIds, storedVersion.id],
  );
  return runIds;
}

async function testIndependentBatchBounds(client: Client): Promise<void> {
  await seedExactCandidates(client, 500);
  let policy = await policyFromDatabase(client);
  let before = await collectAnalysis(client, policy);
  assert.equal(before.candidates.length, 500);
  assert.equal(
    await applyLaunchSnapshotBackfillBatch({
      client,
      candidates: before.candidates.slice(0, 499),
      policy,
    }),
    499,
  );
  assert.equal(
    [...(await snapshots(client)).values()].filter((snapshot) => {
      return snapshot !== null;
    }).length,
    499,
  );

  await seedExactCandidates(client, 500);
  policy = await policyFromDatabase(client);
  before = await collectAnalysis(client, policy);
  assert.equal(
    await applyLaunchSnapshotBackfillBatch({
      client,
      candidates: before.candidates,
      policy,
    }),
    500,
  );
  assert.equal(
    [...(await snapshots(client)).values()].filter((snapshot) => {
      return snapshot !== null;
    }).length,
    500,
  );

  await assertRejectedGate(
    applyLaunchSnapshotBackfillBatch({
      client,
      candidates: [],
      policy,
    }),
    "batch.size",
  );
  await assertRejectedGate(
    applyLaunchSnapshotBackfillBatch({
      client,
      candidates: Array.from(
        { length: LAUNCH_SNAPSHOT_BACKFILL_MAX_BATCH_SIZE + 1 },
        (_, index) => {
          return { runId: uuid(1000 + index), snapshot: defaultSnapshot };
        },
      ),
      policy,
    }),
    "batch.size",
  );
}

export async function validateLaunchSnapshotBackfillDatabase(
  databaseUrl: string,
): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await createTestSchema(admin);
  const testUrl = databaseUrlForSchema(databaseUrl);
  const client = new Client({ connectionString: testUrl });
  await client.connect();
  try {
    await testDryRunPartialRestartAndNoOp({
      client,
      connectionString: testUrl,
    });
    await testDriftAndGuardedUpdate(client);
    await testContentionAndLockTimeout({ client, connectionString: testUrl });
    await testAffectedRowsAndReadBack(client);
    await testStatementTimeoutPreservesEarlierBatch({
      client,
      connectionString: testUrl,
    });
    await testCancellationRollsBack({ client, connectionString: testUrl });
    await testConnectionInterruptionRollsBack({
      client,
      connectionString: testUrl,
    });
    await testIndependentBatchBounds(client);
  } finally {
    await client.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    await admin.end();
  }
}

export async function validateLaunchSnapshotBackfill(): Promise<void> {
  await validateLaunchSnapshotBackfillStatic();
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await validateLaunchSnapshotBackfillDatabase(databaseUrl);
  console.log("agent run launch snapshot backfill passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateLaunchSnapshotBackfill().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
