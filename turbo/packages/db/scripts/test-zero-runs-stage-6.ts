import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import postgres from "postgres";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { applyPendingMigrations } from "./migration-runner";

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

interface PendingState {
  readonly agentDigest: string;
  readonly appliedCount: number;
  readonly tableName: string | null;
  readonly zeroRunCount: number;
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required");
  }
  return value;
}

const databaseUrl = requiredDatabaseUrl();

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(scriptDirectory, "..");
const migrationsDirectory = path.join(packageDirectory, "src/migrations");
const journalPath = path.join(migrationsDirectory, "meta/_journal.json");
const upgradeDatabase = `migration_zero_runs_stage_6_upgrade_${process.pid}`;
const freshDatabase = `migration_zero_runs_stage_6_fresh_${process.pid}`;
const lifecycleRunId = "00000000-0000-4000-8000-000000092401";
const productRunId = "00000000-0000-4000-8000-000000092402";

function databaseConnectionUrl(databaseName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withAdminClient(
  operation: (client: Client) => Promise<void>,
): Promise<void> {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await operation(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabase(databaseName: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    await client.query(`CREATE DATABASE "${databaseName}"`);
  });
}

async function dropDatabase(databaseName: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  });
}

async function readStage6Entries(): Promise<{
  readonly previous: JournalEntry;
  readonly stage6: JournalEntry;
}> {
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  const matching = journal.entries.filter((entry) => {
    return entry.tag.endsWith("_drop_zero_runs");
  });
  assert.equal(
    matching.length,
    1,
    "Expected exactly one generated drop_zero_runs migration",
  );
  const stage6 = matching[0];
  assert.ok(stage6);
  const previous = journal.entries.find((entry) => {
    return entry.idx === stage6.idx - 1;
  });
  assert.ok(previous, "Expected a migration immediately before Stage 6");
  return { previous, stage6 };
}

async function validateMigrationShape(stage6: JournalEntry): Promise<void> {
  const migrationPath = path.join(migrationsDirectory, `${stage6.tag}.sql`);
  const migrationSql = await fs.readFile(migrationPath, "utf8");
  assert.match(migrationSql, /SET LOCAL lock_timeout = '1s'/u);
  assert.match(migrationSql, /SET LOCAL statement_timeout = '10s'/u);
  assert.match(migrationSql, /to_regclass\('public\.zero_runs'\)/u);
  assert.match(migrationSql, /"pg_depend"/u);
  assert.match(migrationSql, /"pg_rewrite"/u);
  assert.match(migrationSql, /"pg_trigger"/u);
  assert.match(migrationSql, /"prokind" IN \('f', 'p'\)/u);
  assert.match(migrationSql, /sync_zero_run_metadata_to_agent_runs/u);
  assert.match(migrationSql, /backfill_agent_run_metadata_stage2/u);
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(migrationSql, /\bCASCADE\b/iu);
  assert.doesNotMatch(migrationSql, /\bDROP\s+TABLE\s+IF\s+EXISTS\b/iu);
  assert.doesNotMatch(
    migrationSql,
    /\b(?:DELETE\s+FROM|UPDATE)\s+(?:public\.)?"?zero_runs"?/iu,
  );
  assert.equal(
    [...migrationSql.matchAll(/\bDROP TABLE public\.zero_runs\b/gu)].length,
    1,
  );
  assert.ok(
    migrationSql.indexOf("Stage 6 found external constraints") <
      migrationSql.indexOf("DROP TABLE public.zero_runs"),
  );
}

async function seedUpgradeRows(client: Client): Promise<string> {
  await client.query(`
    INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
    VALUES (
      '00000000-0000-4000-8000-000000092410',
      'stage6-user',
      'stage6-drop-probe',
      'stage6-org'
    )
  `);
  await client.query(`
    INSERT INTO "agent_sessions" (
      "id", "user_id", "org_id", "agent_compose_id"
    ) VALUES (
      '00000000-0000-4000-8000-000000092411',
      'stage6-user',
      'stage6-org',
      '00000000-0000-4000-8000-000000092410'
    )
  `);
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id",
        "trigger_source", "autonomy_budget", "selected_model", "summary"
      ) VALUES
        ($1, 'stage6-user',
          '00000000-0000-4000-8000-000000092411',
          'failed', 'durable lifecycle-only history', 'stage6-org',
          NULL, NULL, NULL, NULL),
        ($2, 'stage6-user',
          '00000000-0000-4000-8000-000000092411',
          'completed', 'canonical product run', 'stage6-org',
          'test', 10, 'stage6-model', 'canonical summary')
    `,
    [lifecycleRunId, productRunId],
  );
  await client.query(
    `
      INSERT INTO "zero_runs" (
        "id", "trigger_source", "autonomy_budget", "selected_model", "summary"
      ) VALUES ($1, 'test', 10, 'stage6-model', 'canonical summary')
    `,
    [productRunId],
  );
  return await readAgentDigest(client);
}

async function readAgentDigest(client: Client): Promise<string> {
  const result = await client.query<{ digest: string }>(
    `
      SELECT md5(COALESCE(
        string_agg(to_jsonb("run")::text, '' ORDER BY "run"."id"),
        ''
      )) AS "digest"
      FROM "agent_runs" AS "run"
      WHERE "run"."id" IN ($1, $2)
    `,
    [lifecycleRunId, productRunId],
  );
  const digest = result.rows[0]?.digest;
  assert.ok(digest);
  return digest;
}

async function readPendingState(
  client: Client,
  stage6: JournalEntry,
): Promise<PendingState> {
  const state = await client.query<{
    appliedCount: number;
    tableName: string | null;
    zeroRunCount: number;
  }>(
    `
      SELECT
        to_regclass('public.zero_runs')::text AS "tableName",
        (SELECT count(*)::integer FROM "zero_runs") AS "zeroRunCount",
        (
          SELECT count(*)::integer
          FROM "drizzle"."__drizzle_migrations"
          WHERE "created_at" = $1
        ) AS "appliedCount"
    `,
    [stage6.when],
  );
  const row = state.rows[0];
  assert.ok(row);
  return { ...row, agentDigest: await readAgentDigest(client) };
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function expectMigrationFailure(
  sql: postgres.Sql,
  expectedFragments: readonly string[],
): Promise<{ readonly elapsedMs: number; readonly error: Error }> {
  const startedAt = performance.now();
  let failure: unknown;
  try {
    await applyPendingMigrations(sql);
  } catch (error) {
    failure = error;
  }
  const elapsedMs = performance.now() - startedAt;
  assert.ok(failure instanceof Error, "Expected the Stage 6 migration to fail");
  for (const fragment of expectedFragments) {
    assert.ok(
      failure.message.includes(fragment),
      `Expected migration error to include ${fragment}: ${failure.message}`,
    );
  }
  return { elapsedMs, error: failure };
}

async function assertPreflightFailure(args: {
  readonly cleanupSql: string;
  readonly client: Client;
  readonly expectedFragments: readonly string[];
  readonly expectedAgentDigest: string;
  readonly runner: postgres.Sql;
  readonly setupSql: string;
  readonly stage6: JournalEntry;
}): Promise<void> {
  await args.client.query(args.setupSql);
  try {
    const failure = await expectMigrationFailure(
      args.runner,
      args.expectedFragments,
    );
    assert.equal(errorCode(failure.error), "P0001");
    assert.deepEqual(await readPendingState(args.client, args.stage6), {
      agentDigest: args.expectedAgentDigest,
      appliedCount: 0,
      tableName: "zero_runs",
      zeroRunCount: 1,
    });
  } finally {
    await args.client.query(args.cleanupSql);
  }
}

async function validateCatalogPreflight(args: {
  readonly client: Client;
  readonly expectedAgentDigest: string;
  readonly runner: postgres.Sql;
  readonly stage6: JournalEntry;
}): Promise<void> {
  const common = {
    client: args.client,
    expectedAgentDigest: args.expectedAgentDigest,
    runner: args.runner,
    stage6: args.stage6,
  };
  await assertPreflightFailure({
    ...common,
    setupSql: `
      CREATE TABLE "stage6_zero_runs_external" (
        "id" uuid PRIMARY KEY,
        "zero_run_id" uuid CONSTRAINT "stage6_zero_runs_external_fk"
          REFERENCES "zero_runs"("id")
      )
    `,
    cleanupSql: `DROP TABLE "stage6_zero_runs_external"`,
    expectedFragments: [
      "Stage 6 found external constraints",
      "stage6_zero_runs_external_fk",
    ],
  });
  await assertPreflightFailure({
    ...common,
    setupSql: `
      CREATE FUNCTION "stage6_zero_runs_trigger_function"()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER "stage6_zero_runs_user_trigger"
      BEFORE UPDATE ON "zero_runs"
      FOR EACH ROW EXECUTE FUNCTION "stage6_zero_runs_trigger_function"()
    `,
    cleanupSql: `
      DROP TRIGGER "stage6_zero_runs_user_trigger" ON "zero_runs";
      DROP FUNCTION "stage6_zero_runs_trigger_function"()
    `,
    expectedFragments: [
      "Stage 6 found non-internal triggers",
      "stage6_zero_runs_user_trigger",
    ],
  });
  await assertPreflightFailure({
    ...common,
    setupSql: `
      CREATE FUNCTION "sync_zero_run_metadata_to_agent_runs"()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RETURN NEW;
      END;
      $function$;
      CREATE PROCEDURE "backfill_agent_run_metadata_stage2"(interval)
      LANGUAGE plpgsql AS $procedure$
      BEGIN
        NULL;
      END;
      $procedure$
    `,
    cleanupSql: `
      DROP PROCEDURE "backfill_agent_run_metadata_stage2"(interval);
      DROP FUNCTION "sync_zero_run_metadata_to_agent_runs"()
    `,
    expectedFragments: [
      "Stage 6 found retired zero_runs transition objects",
      "sync_zero_run_metadata_to_agent_runs",
      "backfill_agent_run_metadata_stage2",
    ],
  });
  await assertPreflightFailure({
    ...common,
    setupSql: `
      CREATE FUNCTION "stage6_zero_runs_reader"()
      RETURNS bigint LANGUAGE sql AS $function$
        SELECT count(*) FROM public.zero_runs
      $function$
    `,
    cleanupSql: `DROP FUNCTION "stage6_zero_runs_reader"()`,
    expectedFragments: [
      "Stage 6 found stored routines referencing public.zero_runs",
      "stage6_zero_runs_reader",
    ],
  });
  await assertPreflightFailure({
    ...common,
    setupSql: `
      CREATE VIEW "stage6_zero_runs_view" AS
      SELECT "id" FROM "zero_runs"
    `,
    cleanupSql: `DROP VIEW "stage6_zero_runs_view"`,
    expectedFragments: [
      "Stage 6 found views, materialized views, or rules",
      "stage6_zero_runs_view",
    ],
  });
  await assertPreflightFailure({
    ...common,
    setupSql: `
      CREATE MATERIALIZED VIEW "stage6_zero_runs_materialized_view" AS
      SELECT "id" FROM "zero_runs"
    `,
    cleanupSql: `DROP MATERIALIZED VIEW "stage6_zero_runs_materialized_view"`,
    expectedFragments: [
      "Stage 6 found views, materialized views, or rules",
      "stage6_zero_runs_materialized_view",
    ],
  });
  await assertPreflightFailure({
    ...common,
    setupSql: `CREATE POLICY "stage6_zero_runs_policy" ON "zero_runs" USING (true)`,
    cleanupSql: `DROP POLICY "stage6_zero_runs_policy" ON "zero_runs"`,
    expectedFragments: [
      "Stage 6 found non-allowlisted pg_depend objects",
      "stage6_zero_runs_policy",
    ],
  });
}

async function readAgentRunsSchema(client: Client): Promise<unknown> {
  const columns = await client.query(`
      SELECT
        "column_name", "data_type", "udt_name", "is_nullable",
        "column_default"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public' AND "table_name" = 'agent_runs'
      ORDER BY "ordinal_position"
    `);
  const constraints = await client.query(`
      SELECT "conname", "contype", pg_get_constraintdef("oid", true) AS "definition"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
      ORDER BY "conname"
    `);
  const indexes = await client.query(`
      SELECT "indexname", "indexdef"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public' AND "tablename" = 'agent_runs'
      ORDER BY "indexname"
    `);
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

async function validateFreshReplay(upgradeSchema: unknown): Promise<void> {
  await recreateDatabase(freshDatabase);
  const freshUrl = databaseConnectionUrl(freshDatabase);
  const runner = postgres(freshUrl, { max: 1 });
  try {
    await applyPendingMigrations(runner);
  } finally {
    await runner.end();
  }

  const client = new Client({ connectionString: freshUrl });
  await client.connect();
  try {
    const retiredTable = await client.query<{ tableName: string | null }>(`
      SELECT to_regclass('public.zero_runs')::text AS "tableName"
    `);
    assert.deepEqual(retiredTable.rows, [{ tableName: null }]);
    assert.deepEqual(await readAgentRunsSchema(client), upgradeSchema);

    await client.query(`
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES (
        '00000000-0000-4000-8000-000000092420',
        'stage6-fresh-user',
        'stage6-fresh-probe',
        'stage6-fresh-org'
      )
    `);
    await client.query(`
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000092421',
        'stage6-fresh-user',
        'stage6-fresh-org',
        '00000000-0000-4000-8000-000000092420'
      )
    `);
    await client.query(`
      INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id",
        "trigger_source", "autonomy_budget"
      ) VALUES
        ('00000000-0000-4000-8000-000000092422', 'stage6-fresh-user',
          '00000000-0000-4000-8000-000000092421', 'failed',
          'fresh lifecycle-only history', 'stage6-fresh-org', NULL, NULL),
        ('00000000-0000-4000-8000-000000092423', 'stage6-fresh-user',
          '00000000-0000-4000-8000-000000092421', 'completed',
          'fresh product run', 'stage6-fresh-org', 'test', 10)
    `);
    const states = await client.query<{
      autonomyBudget: number | null;
      triggerSource: string | null;
    }>(`
      SELECT
        "trigger_source" AS "triggerSource",
        "autonomy_budget" AS "autonomyBudget"
      FROM "agent_runs"
      WHERE "id" IN (
        '00000000-0000-4000-8000-000000092422',
        '00000000-0000-4000-8000-000000092423'
      )
      ORDER BY "id"
    `);
    assert.deepEqual(states.rows, [
      { autonomyBudget: null, triggerSource: null },
      { autonomyBudget: 10, triggerSource: "test" },
    ]);
  } finally {
    await client.end();
  }
}

async function validateStage6(): Promise<void> {
  const entries = await readStage6Entries();
  await validateMigrationShape(entries.stage6);
  await recreateDatabase(upgradeDatabase);
  const upgradeUrl = databaseConnectionUrl(upgradeDatabase);
  const control = new Client({ connectionString: upgradeUrl });
  await control.connect();
  let runner = postgres(upgradeUrl, { max: 1 });
  const originalDirectory = process.cwd();
  process.chdir(packageDirectory);
  try {
    await applyMigrationsFromDirectoryUpToTag(
      control,
      migrationsDirectory,
      entries.previous.tag,
    );
    const expectedAgentDigest = await seedUpgradeRows(control);
    await validateCatalogPreflight({
      client: control,
      expectedAgentDigest,
      runner,
      stage6: entries.stage6,
    });

    const locker = new Client({ connectionString: upgradeUrl });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`LOCK TABLE "zero_runs" IN ACCESS SHARE MODE`);
      const lockFailure = await expectMigrationFailure(runner, [
        "canceling statement due to lock timeout",
      ]);
      assert.equal(errorCode(lockFailure.error), "55P03");
      assert.ok(
        lockFailure.elapsedMs >= 750 && lockFailure.elapsedMs < 4_000,
        `Expected the lock failure near the one-second budget, got ${String(lockFailure.elapsedMs)}ms`,
      );
      assert.deepEqual(await readPendingState(control, entries.stage6), {
        agentDigest: expectedAgentDigest,
        appliedCount: 0,
        tableName: "zero_runs",
        zeroRunCount: 1,
      });
      await locker.query("COMMIT");

      await runner.end();
      runner = postgres(upgradeUrl, { max: 1 });
      await applyPendingMigrations(runner);

      const migratedState = await control.query<{
        appliedCount: number;
        tableName: string | null;
      }>(
        `
          SELECT
            to_regclass('public.zero_runs')::text AS "tableName",
            (
              SELECT count(*)::integer
              FROM "drizzle"."__drizzle_migrations"
              WHERE "created_at" = $1
            ) AS "appliedCount"
        `,
        [entries.stage6.when],
      );
      assert.deepEqual(migratedState.rows, [
        { appliedCount: 1, tableName: null },
      ]);
      assert.equal(await readAgentDigest(control), expectedAgentDigest);

      const upgradeSchema = await readAgentRunsSchema(control);
      await validateFreshReplay(upgradeSchema);
      console.log(
        `Stage 6 lock failure observed after ${lockFailure.elapsedMs.toFixed(0)}ms; clean retry and fresh replay succeeded`,
      );
    } finally {
      await locker.query("ROLLBACK").catch(() => {
        return undefined;
      });
      await locker.end();
    }
  } finally {
    process.chdir(originalDirectory);
    await runner.end().catch(() => {
      return undefined;
    });
    await control.end();
  }
}

try {
  await validateStage6();
} finally {
  await dropDatabase(upgradeDatabase);
  await dropDatabase(freshDatabase);
}
