import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { Client } from "pg";
import {
  assertProductionExceptionConstants,
  assertStage2PooledTransactionShape,
  assertStage2NoticeVariableBindings,
  createCallbackFixtureExecutionSql,
  createTransactionTimeoutExecutionSql,
  productionAgentOnlyDigest,
  seedAcceptedAgentOnlyRows,
  seedAcceptedCallbacks,
  seedPairedMetadataMismatches,
  stage2Migration,
} from "./agent-run-metadata-stage-2-test-fixtures";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  applyPendingMigrations,
  NON_TRANSACTIONAL_MIGRATION_MARKER,
} from "./migration-runner";

const expansionMigration = "0919_clammy_mastermind";
const minimumLedgerTimestamp = 1786617147388;
const runnerFixtureTimestamp = minimumLedgerTimestamp + 1;
const finalTestDatabase = "migration_agent_run_metadata_stage_2_final";
const runnerTestDatabase = "migration_agent_run_metadata_stage_2_runner";

function splitMigrationStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

async function createTestDatabase(
  databaseUrl: string,
  databaseName: string,
): Promise<{ admin: Client; client: Client; testUrl: URL }> {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const client = new Client({ connectionString: testUrl.toString() });
  await client.connect();
  return { admin, client, testUrl };
}

async function dropTestDatabase(
  admin: Client,
  client: Client,
  databaseName: string,
): Promise<void> {
  await client.query("ROLLBACK").catch(() => {
    return undefined;
  });
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
}

async function metadataMismatchCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "zero_runs" AS "source"
    INNER JOIN "agent_runs" AS "target" ON "target"."id" = "source"."id"
    WHERE ROW(
      "target"."trigger_source",
      "target"."autonomy_budget",
      "target"."workflow_automation_id",
      "target"."goal_id",
      "target"."model_provider",
      "target"."model_provider_id",
      "target"."model_provider_credential_scope",
      "target"."selected_model",
      "target"."codex_service_tier",
      "target"."selected_video_model",
      "target"."chat_thread_id",
      "target"."api_started_at",
      "target"."first_assistant_event_acknowledged_at",
      "target"."summary",
      "target"."trigger_brief"
    ) IS DISTINCT FROM ROW(
      "source"."trigger_source",
      "source"."autonomy_budget",
      "source"."workflow_automation_id",
      "source"."goal_id",
      "source"."model_provider",
      "source"."model_provider_id",
      "source"."model_provider_credential_scope",
      "source"."selected_model",
      "source"."codex_service_tier",
      "source"."selected_video_model",
      "source"."chat_thread_id",
      "source"."api_started_at",
      "source"."first_assistant_event_acknowledged_at",
      "source"."summary",
      "source"."trigger_brief"
    )
  `);
  return result.rows[0]?.count ?? -1;
}

async function executeStatements(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await client.query(statement);
  }
}

async function expectFinalSnapshotFailure(
  client: Client,
  statements: readonly string[],
  finalStart: number,
  expected: RegExp,
): Promise<void> {
  await client.query(statements[finalStart]!);
  await client.query(statements[finalStart + 1]!);
  await client.query(statements[finalStart + 2]!);
  await assert.rejects(client.query(statements[finalStart + 3]!), expected);
  await client.query("ROLLBACK");
}

function expectedNotices(callbackDigest: string): {
  readonly final: string;
  readonly preflight: string;
} {
  return {
    preflight:
      "Stage 2 agent-run metadata preflight: " +
      `ledger=${minimumLedgerTimestamp}, agent_runs=18, zero_runs=2, ` +
      "paired=2, zero_only=0, invalid_sources=0, agent_only=16, " +
      `agent_only_digest=${productionAgentOnlyDigest}, callbacks=12, ` +
      `callback_runs=10, callback_digest=${callbackDigest}, ` +
      "inbound_fks=20, reviewed_non_fk_fields=14, " +
      "fk_dependency_matches=0, non_fk_dependency_matches=0, " +
      "bridge_triggers=1",
    final:
      "Stage 2 agent-run metadata validation: " +
      "agent_runs=18, zero_runs=2, paired=2, zero_only=0, " +
      "invalid_sources=0, agent_only=16, " +
      `agent_only_digest=${productionAgentOnlyDigest}, callbacks=12, ` +
      `callback_runs=10, callback_digest=${callbackDigest}, ` +
      "metadata_mismatches=0, inbound_fks=20, " +
      "reviewed_non_fk_fields=14, fk_dependency_matches=0, " +
      "non_fk_dependency_matches=0, ready_valid_indexes=3, " +
      "recovery_indexes=0, validated_constraints=4, bridge_triggers=1",
  };
}

async function validateFinalArtifacts(client: Client): Promise<void> {
  const indexes = await client.query<{
    definition: string;
    name: string;
    ready: boolean;
    valid: boolean;
  }>(`
    SELECT
      "index_class"."relname" AS "name",
      pg_get_indexdef("index_class"."oid") AS "definition",
      "index_row"."indisready" AS "ready",
      "index_row"."indisvalid" AS "valid"
    FROM "pg_class" AS "index_class"
    INNER JOIN "pg_namespace" AS "index_namespace"
      ON "index_namespace"."oid" = "index_class"."relnamespace"
    INNER JOIN "pg_index" AS "index_row"
      ON "index_row"."indexrelid" = "index_class"."oid"
    WHERE "index_namespace"."nspname" = 'public'
      AND "index_class"."relname" IN (
        'idx_agent_runs_chat_thread_id',
        'idx_agent_runs_workflow_automation',
        'idx_agent_runs_goal'
      )
    ORDER BY "index_class"."relname"
  `);
  assert.deepEqual(indexes.rows, [
    {
      definition:
        "CREATE INDEX idx_agent_runs_chat_thread_id ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)",
      name: "idx_agent_runs_chat_thread_id",
      ready: true,
      valid: true,
    },
    {
      definition:
        "CREATE INDEX idx_agent_runs_goal ON public.agent_runs USING btree (goal_id) WHERE (goal_id IS NOT NULL)",
      name: "idx_agent_runs_goal",
      ready: true,
      valid: true,
    },
    {
      definition:
        "CREATE INDEX idx_agent_runs_workflow_automation ON public.agent_runs USING btree (workflow_automation_id) WHERE (workflow_automation_id IS NOT NULL)",
      name: "idx_agent_runs_workflow_automation",
      ready: true,
      valid: true,
    },
  ]);

  const constraints = await client.query<{
    definition: string;
    name: string;
    validated: boolean;
  }>(`
    SELECT
      "conname" AS "name",
      pg_get_constraintdef("oid", true) AS "definition",
      "convalidated" AS "validated"
    FROM "pg_constraint"
    WHERE "conrelid" = 'public.agent_runs'::regclass
      AND "conname" IN (
        'agent_runs_chat_thread_id_chat_threads_id_fk',
        'agent_runs_workflow_automation_id_zero_workflow_automations_id_',
        'agent_runs_goal_id_thread_goals_id_fk',
        'agent_runs_autonomy_budget_check'
      )
    ORDER BY "conname"
  `);
  assert.deepEqual(constraints.rows, [
    {
      definition: "CHECK (autonomy_budget >= 0 AND autonomy_budget <= 10)",
      name: "agent_runs_autonomy_budget_check",
      validated: true,
    },
    {
      definition:
        "FOREIGN KEY (chat_thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL",
      name: "agent_runs_chat_thread_id_chat_threads_id_fk",
      validated: true,
    },
    {
      definition:
        "FOREIGN KEY (goal_id) REFERENCES thread_goals(id) ON DELETE SET NULL",
      name: "agent_runs_goal_id_thread_goals_id_fk",
      validated: true,
    },
    {
      definition:
        "FOREIGN KEY (workflow_automation_id) REFERENCES zero_workflow_automations(id) ON DELETE SET NULL",
      name: "agent_runs_workflow_automation_id_zero_workflow_automations_id_",
      validated: true,
    },
  ]);

  const recovery = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "pg_class" AS "index_class"
    INNER JOIN "pg_namespace" AS "index_namespace"
      ON "index_namespace"."oid" = "index_class"."relnamespace"
    WHERE "index_namespace"."nspname" = 'public'
      AND "index_class"."relname" IN (
        'idx_agent_runs_chat_thread_id_stage2_invalid',
        'idx_agent_runs_workflow_automation_stage2_invalid',
        'idx_agent_runs_goal_stage2_invalid'
      )
  `);
  assert.deepEqual(recovery.rows, [{ count: 0 }]);
}

export async function validateAgentRunMetadataStage2Final(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${stage2Migration}.sql`),
    "utf8",
  );
  assertProductionExceptionConstants(migrationSql, 2);
  assertStage2PooledTransactionShape(migrationSql);
  assertStage2NoticeVariableBindings(migrationSql);

  const { admin, client } = await createTestDatabase(
    databaseUrl,
    finalTestDatabase,
  );
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    await seedAcceptedAgentOnlyRows(client);
    const callbackDigest = await seedAcceptedCallbacks(client);
    await seedPairedMetadataMismatches(client, 2);
    const relationBefore = await client.query<{ fileNode: string }>(`
      SELECT pg_relation_filenode('public.agent_runs'::regclass)::text
        AS "fileNode"
    `);

    const executionSql = createCallbackFixtureExecutionSql(
      migrationSql,
      callbackDigest,
      2,
    );
    const statements = splitMigrationStatements(executionSql);
    const finalStarts = statements
      .map((statement, index) => {
        return statement.endsWith(
          "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
        )
          ? index
          : -1;
      })
      .filter((index) => {
        return index >= 0;
      });
    assert.equal(finalStarts.length, 2);
    const finalStart = finalStarts[1]!;
    const notices: string[] = [];
    const listener = (notice: { message?: string }): void => {
      if (notice.message) notices.push(notice.message);
    };
    client.on("notice", listener);
    try {
      await executeStatements(client, statements.slice(0, finalStart));
      assert.equal(await metadataMismatchCount(client), 0);

      await client.query(`
        UPDATE "agent_run_callbacks"
        SET "status" = 'pending'
        WHERE "id" = (
          SELECT "id" FROM "agent_run_callbacks" ORDER BY "id" LIMIT 1
        )
      `);
      await expectFinalSnapshotFailure(
        client,
        statements,
        finalStart,
        /Stage 2 final callback exception mismatch: count 12, run_count 10, digest [0-9a-f]{32}, invalid_shape 1/,
      );
      await client.query(`
        UPDATE "agent_run_callbacks"
        SET "status" = 'delivered'
        WHERE "id" = (
          SELECT "id" FROM "agent_run_callbacks" ORDER BY "id" LIMIT 1
        )
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION "sync_zero_run_metadata_to_agent_runs"()
        RETURNS trigger AS $$
        BEGIN
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await expectFinalSnapshotFailure(
        client,
        statements,
        finalStart,
        /Stage 2 final validation found 0 exact enabled Stage 1 bridge triggers/,
      );
      const expansionSql = await fs.readFile(
        path.join(migrationsDirectory, `${expansionMigration}.sql`),
        "utf8",
      );
      const bridgeFunction = splitMigrationStatements(expansionSql).find(
        (statement) => {
          return statement.includes(
            'CREATE FUNCTION "sync_zero_run_metadata_to_agent_runs"()',
          );
        },
      );
      assert.ok(bridgeFunction);
      await client.query(
        bridgeFunction.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
      );

      await client.query(`
        CREATE INDEX "idx_agent_runs_chat_thread_id_stage2_invalid"
        ON "agent_runs" USING btree ("chat_thread_id")
        WHERE "chat_thread_id" IS NOT NULL
      `);
      await expectFinalSnapshotFailure(
        client,
        statements,
        finalStart,
        /Stage 2 final validation found 1 invalid-index recovery artifacts/,
      );
      await client.query(
        'DROP INDEX "idx_agent_runs_chat_thread_id_stage2_invalid"',
      );

      await executeStatements(client, statements.slice(finalStart));
    } finally {
      client.off("notice", listener);
    }

    const expected = expectedNotices(callbackDigest);
    assert.deepEqual(
      notices.filter((notice) => {
        return notice.startsWith("Stage 2 agent-run metadata");
      }),
      [expected.preflight, expected.final],
    );
    assert.deepEqual(
      await client
        .query<{ fileNode: string }>(
          `
        SELECT pg_relation_filenode('public.agent_runs'::regclass)::text
          AS "fileNode"
      `,
        )
        .then((result) => {
          return result.rows;
        }),
      relationBefore.rows,
    );
    await validateFinalArtifacts(client);

    const acceptedShape = await client.query<{
      count: number;
      digest: string;
      invalidShape: number;
    }>(`
      SELECT
        count(*)::integer AS "count",
        md5(string_agg("agent_run"."id"::text, ',' ORDER BY "agent_run"."id"))
          AS "digest",
        count(*) FILTER (
          WHERE "agent_run"."status" IS DISTINCT FROM 'failed'
            OR "agent_run"."created_at" < timestamp '2026-03-30 00:00:00'
            OR "agent_run"."created_at" >= timestamp '2026-04-09 00:00:00'
            OR "agent_run"."started_at" IS NOT NULL
            OR "agent_run"."sandbox_id" IS NOT NULL
            OR "agent_run"."last_event_sequence" IS NOT NULL
            OR "agent_run"."trigger_source" IS NOT NULL
            OR "agent_run"."autonomy_budget" IS NOT NULL
            OR "agent_run"."workflow_automation_id" IS NOT NULL
            OR "agent_run"."goal_id" IS NOT NULL
            OR "agent_run"."model_provider" IS NOT NULL
            OR "agent_run"."model_provider_id" IS NOT NULL
            OR "agent_run"."model_provider_credential_scope" IS NOT NULL
            OR "agent_run"."selected_model" IS NOT NULL
            OR "agent_run"."codex_service_tier" IS NOT NULL
            OR "agent_run"."selected_video_model" IS NOT NULL
            OR "agent_run"."chat_thread_id" IS NOT NULL
            OR "agent_run"."api_started_at" IS NOT NULL
            OR "agent_run"."first_assistant_event_acknowledged_at" IS NOT NULL
            OR "agent_run"."summary" IS NOT NULL
            OR "agent_run"."trigger_brief" IS NOT NULL
        )::integer AS "invalidShape"
      FROM "agent_runs" AS "agent_run"
      LEFT JOIN "zero_runs" AS "zero_run" ON "zero_run"."id" = "agent_run"."id"
      WHERE "zero_run"."id" IS NULL
    `);
    assert.deepEqual(acceptedShape.rows, [
      {
        count: 16,
        digest: productionAgentOnlyDigest,
        invalidShape: 0,
      },
    ]);

    await client.query(`
      UPDATE "zero_runs"
      SET "summary" = 'post-validation bridge proof'
      WHERE "id" = (SELECT "id" FROM "zero_runs" ORDER BY "id" LIMIT 1)
    `);
    assert.equal(await metadataMismatchCount(client), 0);
    const timeouts = await client.query<{
      lockTimeout: string;
      statementTimeout: string;
      transactionTimeout: string;
    }>(`
      SELECT
        current_setting('lock_timeout') AS "lockTimeout",
        current_setting('statement_timeout') AS "statementTimeout",
        current_setting('transaction_timeout') AS "transactionTimeout"
    `);
    assert.deepEqual(timeouts.rows, [
      {
        lockTimeout: "0",
        statementTimeout: "0",
        transactionTimeout: "0",
      },
    ]);
  } finally {
    await dropTestDatabase(admin, client, finalTestDatabase);
  }

  console.log("stage2 final snapshot probe passed");
}

async function writeRunnerFixture(
  fixtureDirectory: string,
  migrationSql: string,
): Promise<void> {
  const migrationsDirectory = path.join(fixtureDirectory, "src/migrations");
  await fs.mkdir(path.join(migrationsDirectory, "meta"), { recursive: true });
  await fs.writeFile(
    path.join(migrationsDirectory, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: runnerFixtureTimestamp,
          tag: "stage2_agent_run_metadata_runner_fixture",
          breakpoints: true,
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(
      migrationsDirectory,
      "stage2_agent_run_metadata_runner_fixture.sql",
    ),
    migrationSql,
  );
}

async function runActualMigrationRunner(
  testUrl: URL,
  fixtureDirectory: string,
): Promise<postgres.Sql> {
  const sql = postgres(testUrl.toString(), {
    max: 1,
    onnotice: () => {
      return undefined;
    },
  });
  const originalDirectory = process.cwd();
  process.chdir(fixtureDirectory);
  try {
    await applyPendingMigrations(sql);
    return sql;
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => {
      return undefined;
    });
    throw error;
  } finally {
    process.chdir(originalDirectory);
  }
}

async function validateStatementTimeoutCallProtocol(
  testUrl: URL,
): Promise<void> {
  const sql = postgres(testUrl.toString(), { max: 1 });
  try {
    await sql.unsafe(`
      CREATE OR REPLACE PROCEDURE "stage2_statement_timeout_protocol_probe"()
      LANGUAGE plpgsql AS $$
      BEGIN
        SET LOCAL statement_timeout = '50ms';
        PERFORM pg_sleep(0.2);
      END;
      $$
    `);
    const startedAt = process.hrtime.bigint();
    await sql.unsafe('CALL "stage2_statement_timeout_protocol_probe"()');
    const elapsedMilliseconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.ok(
      elapsedMilliseconds >= 150,
      `expected in-CALL statement_timeout to be ineffective, completed in ${elapsedMilliseconds.toFixed(1)}ms`,
    );
    assert.ok(
      elapsedMilliseconds < 5_000,
      `statement_timeout protocol probe exceeded 5s: ${elapsedMilliseconds.toFixed(1)}ms`,
    );
    const settings = await sql<
      { statementTimeout: string; transactionTimeout: string }[]
    >`
      SELECT
        current_setting('statement_timeout') AS "statementTimeout",
        current_setting('transaction_timeout') AS "transactionTimeout"
    `;
    assert.deepEqual(
      [...settings],
      [{ statementTimeout: "0", transactionTimeout: "0" }],
    );
  } finally {
    await sql
      .unsafe(
        'DROP PROCEDURE IF EXISTS "stage2_statement_timeout_protocol_probe"()',
      )
      .catch(() => {
        return undefined;
      });
    await sql.end({ timeout: 1 });
  }
}

async function installTransactionTimeoutProbe(
  client: Client,
  slowRunId: string,
): Promise<void> {
  await client.query(`CREATE SCHEMA "stage2_test"`);
  await client.query(`
    CREATE TABLE "stage2_test"."transaction_timeout_probe" (
      "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
      "backend_pid" integer,
      "slow_run_id" uuid NOT NULL
    )
  `);
  await client.query(
    `
      INSERT INTO "stage2_test"."transaction_timeout_probe" ("slow_run_id")
      VALUES ($1)
    `,
    [slowRunId],
  );
  await client.query(`
    CREATE OR REPLACE FUNCTION "stage2_test"."transaction_timeout_probe_update"()
    RETURNS trigger AS $$
    BEGIN
      UPDATE "stage2_test"."transaction_timeout_probe"
      SET "backend_pid" = pg_backend_pid()
      WHERE "backend_pid" IS DISTINCT FROM pg_backend_pid();
      IF NEW."id" = (
        SELECT "slow_run_id"
        FROM "stage2_test"."transaction_timeout_probe"
      ) THEN
        PERFORM pg_sleep(3);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    CREATE TRIGGER "stage2_transaction_timeout_probe_update"
    BEFORE UPDATE OF "summary" ON "agent_runs"
    FOR EACH ROW
    EXECUTE FUNCTION "stage2_test"."transaction_timeout_probe_update"()
  `);
}

async function dropTransactionTimeoutProbe(client: Client): Promise<void> {
  await client.query(`
    DROP TRIGGER IF EXISTS "stage2_transaction_timeout_probe_update"
    ON "agent_runs"
  `);
  await client.query(`
    DROP FUNCTION IF EXISTS "stage2_test"."transaction_timeout_probe_update"()
  `);
  await client.query(`DROP SCHEMA IF EXISTS "stage2_test" CASCADE`);
}

export async function validateAgentRunMetadataStage2Runner(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${stage2Migration}.sql`),
    "utf8",
  );
  assert.equal(
    migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER),
    true,
  );
  assertProductionExceptionConstants(migrationSql, 2);
  assertStage2PooledTransactionShape(migrationSql);

  const fixtureDirectory = await fs.mkdtemp(
    path.join(tmpdir(), "okou-stage2-runner-"),
  );
  const { admin, client, testUrl } = await createTestDatabase(
    databaseUrl,
    runnerTestDatabase,
  );
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    await seedAcceptedAgentOnlyRows(client);
    const callbackDigest = await seedAcceptedCallbacks(client);
    const runIds = await seedPairedMetadataMismatches(client, 502);
    await validateStatementTimeoutCallProtocol(testUrl);
    await installTransactionTimeoutProbe(client, runIds[500]!);
    await writeRunnerFixture(
      fixtureDirectory,
      createTransactionTimeoutExecutionSql(
        createCallbackFixtureExecutionSql(migrationSql, callbackDigest, 2),
      ),
    );

    const failureStartedAt = process.hrtime.bigint();
    await assert.rejects(
      runActualMigrationRunner(testUrl, fixtureDirectory),
      /CONNECTION_CLOSED|transaction timeout/iu,
    );
    const failureElapsedMilliseconds =
      Number(process.hrtime.bigint() - failureStartedAt) / 1_000_000;
    assert.ok(
      failureElapsedMilliseconds < 5_000,
      `expected the 1s transaction timeout to fail within 5s, took ${failureElapsedMilliseconds.toFixed(1)}ms`,
    );
    console.log(
      `stage2 actual migration-runner transaction timeout took ${failureElapsedMilliseconds.toFixed(1)}ms`,
    );
    const failedBackend = await client.query<{ backendPid: number }>(`
      SELECT "backend_pid" AS "backendPid"
      FROM "stage2_test"."transaction_timeout_probe"
    `);
    const failedBackendPid = failedBackend.rows[0]?.backendPid;
    assert.ok(failedBackendPid);
    const failedBackendActivity = await client.query<{ present: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM "pg_stat_activity" WHERE "pid" = $1
        ) AS "present"
      `,
      [failedBackendPid],
    );
    assert.deepEqual(failedBackendActivity.rows, [{ present: false }]);
    const failedLedger = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${runnerFixtureTimestamp}
    `);
    assert.deepEqual(failedLedger.rows, [{ count: 0 }]);
    assert.equal(await metadataMismatchCount(client), 2);
    const committedFirstBatch = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "zero_runs" AS "source"
        INNER JOIN "agent_runs" AS "target"
          ON "target"."id" = "source"."id"
        WHERE "target"."id" = ANY($1::uuid[])
          AND "target"."summary" IS NOT DISTINCT FROM "source"."summary"
      `,
      [runIds.slice(0, 500)],
    );
    assert.deepEqual(committedFirstBatch.rows, [{ count: 500 }]);

    await dropTransactionTimeoutProbe(client);
    const successfulRunner = await runActualMigrationRunner(
      testUrl,
      fixtureDirectory,
    );
    try {
      const timeouts = await successfulRunner<
        {
          backendPid: number;
          lockTimeout: string;
          statementTimeout: string;
          transactionTimeout: string;
        }[]
      >`
        SELECT
          pg_backend_pid() AS "backendPid",
          current_setting('lock_timeout') AS "lockTimeout",
          current_setting('statement_timeout') AS "statementTimeout",
          current_setting('transaction_timeout') AS "transactionTimeout"
      `;
      assert.notEqual(timeouts[0]?.backendPid, failedBackendPid);
      assert.deepEqual(
        [...timeouts].map(({ backendPid: _, ...row }) => {
          return row;
        }),
        [
          {
            lockTimeout: "0",
            statementTimeout: "0",
            transactionTimeout: "0",
          },
        ],
      );
    } finally {
      await successfulRunner.end();
    }
    const successfulLedger = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count"
      FROM "drizzle"."__drizzle_migrations"
      WHERE "created_at" = ${runnerFixtureTimestamp}
    `);
    assert.deepEqual(successfulLedger.rows, [{ count: 1 }]);
    assert.equal(await metadataMismatchCount(client), 0);
    await validateFinalArtifacts(client);
  } finally {
    await dropTransactionTimeoutProbe(client).catch(() => {
      return undefined;
    });
    await dropTestDatabase(admin, client, runnerTestDatabase);
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
  }

  console.log("stage2 actual migration-runner probe passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  Promise.resolve()
    .then(async () => {
      await validateAgentRunMetadataStage2Final();
      await validateAgentRunMetadataStage2Runner();
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
