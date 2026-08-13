import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const expansionMigration = "0919_clammy_mastermind";
const testDatabase = "migration_agent_run_metadata_stage_2_lock_draft";

export async function validateAgentRunMetadataStage2LockDraft(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const draftPath = path.join(
    scriptDirectory,
    "agent-run-metadata-stage-2-draft.sql",
  );
  const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const draft = await fs.readFile(draftPath, "utf8");
  const locatedBackfillStatement = draft
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .find((statement) => {
      return statement.includes(
        "Stage 2 backfill no-progress timeout must be positive",
      );
    });
  assert.ok(locatedBackfillStatement);
  const backfillStatement: string = locatedBackfillStatement;
  assert.match(backfillStatement, /FOR UPDATE OF "target" SKIP LOCKED/u);
  const batchStatement = backfillStatement.match(
    /WITH "batch" AS MATERIALIZED \(([\s\S]*?)\),\s*"updated" AS \(([\s\S]*?)\)\s*SELECT/u,
  );
  assert.ok(batchStatement);
  const candidateSql = batchStatement[1]!;
  const updateSql = batchStatement[2]!;
  assert.match(candidateSql, /SELECT\s+"target"\."id",/u);
  for (const column of [
    "trigger_source",
    "autonomy_budget",
    "workflow_automation_id",
    "goal_id",
    "model_provider",
    "model_provider_id",
    "model_provider_credential_scope",
    "selected_model",
    "codex_service_tier",
    "selected_video_model",
    "chat_thread_id",
    "api_started_at",
    "first_assistant_event_acknowledged_at",
    "summary",
    "trigger_brief",
  ]) {
    assert.ok(candidateSql.includes(`"candidate"."${column}"`));
    assert.ok(updateSql.includes(`"batch"."${column}"`));
  }
  assert.match(
    candidateSql,
    /ORDER BY "target"\."id"\s+LIMIT 500\s+FOR UPDATE OF "target" SKIP LOCKED/u,
  );
  assert.match(updateSql, /FROM "batch"/u);
  assert.doesNotMatch(updateSql, /"zero_runs"|"candidate"/u);
  assert.doesNotMatch(updateSql, /\bJOIN\b/iu);
  assert.deepEqual(
    [...draft.matchAll(/FOR UPDATE OF\s+"([^"]+)"/gu)].map((match) => {
      return match[1];
    }),
    ["target"],
  );
  assert.doesNotMatch(draft, /\bLOCK\s+TABLE\b/iu);

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: testUrl.toString() });
    await client.connect();
    return client;
  }

  async function seed(client: Client, count: number): Promise<string[]> {
    await client.query(`
    DELETE FROM "agent_runs"
    WHERE "user_id" = 'stage2-lock-probe-user'
  `);
    await client.query(`
    INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
    VALUES (
      '00000000-0000-4000-8000-000000092200',
      'stage2-lock-probe-user',
      'stage2-lock-probe',
      'stage2-lock-probe-org'
    )
    ON CONFLICT ("id") DO NOTHING
  `);
    await client.query(`
    INSERT INTO "agent_sessions" (
      "id", "user_id", "org_id", "agent_compose_id"
    ) VALUES (
      '00000000-0000-4000-8000-000000092201',
      'stage2-lock-probe-user',
      'stage2-lock-probe-org',
      '00000000-0000-4000-8000-000000092200'
    )
    ON CONFLICT ("id") DO NOTHING
  `);
    const inserted = await client.query<{ id: string }>(
      `
      WITH "fixture" AS (
        SELECT
          (
            substr(md5('stage2-lock-probe-' || "position"), 1, 8) || '-' ||
            substr(md5('stage2-lock-probe-' || "position"), 9, 4) || '-4' ||
            substr(md5('stage2-lock-probe-' || "position"), 14, 3) || '-8' ||
            substr(md5('stage2-lock-probe-' || "position"), 18, 3) || '-' ||
            substr(md5('stage2-lock-probe-' || "position"), 21, 12)
          )::uuid AS "id",
          "position"
        FROM generate_series(1, $1::integer) AS "series"("position")
      ),
      "inserted_agent_run" AS (
        INSERT INTO "agent_runs" (
          "id", "status", "prompt", "user_id", "org_id", "session_id"
        )
        SELECT
          "id", 'pending', 'stage2 lock probe',
          'stage2-lock-probe-user', 'stage2-lock-probe-org',
          '00000000-0000-4000-8000-000000092201'
        FROM "fixture"
        RETURNING "id"
      )
      INSERT INTO "zero_runs" (
        "id", "trigger_source", "autonomy_budget", "summary"
      )
      SELECT "id", 'chat', 1, 'source summary'
      FROM "inserted_agent_run"
      RETURNING "id"::text AS "id"
    `,
      [count],
    );
    await client.query(`
    UPDATE "agent_runs"
    SET "summary" = NULL
    WHERE "user_id" = 'stage2-lock-probe-user'
  `);
    return inserted.rows
      .map(({ id }) => {
        return id;
      })
      .sort();
  }

  async function mismatchCount(client: Client): Promise<number> {
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
      AND "target"."user_id" = 'stage2-lock-probe-user'
  `);
    return result.rows[0]?.count ?? -1;
  }

  async function lockTarget(client: Client, runId: string): Promise<void> {
    await client.query("BEGIN");
    await client.query(
      `SELECT 1 FROM "agent_runs" WHERE "id" = $1 FOR UPDATE`,
      [runId],
    );
  }

  async function waitForMismatchCount(
    client: Client,
    expectedCount: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await mismatchCount(client)) === expectedCount) return;
      await new Promise((resolve) => {
        return setTimeout(resolve, 10);
      });
    }
    assert.equal(await mismatchCount(client), expectedCount);
  }

  async function readStrandedCount(
    client: Client,
    runIds: string[],
  ): Promise<{ agentOnly: number; zeroOnly: number }[]> {
    const stranded = await client.query<{
      agentOnly: number;
      zeroOnly: number;
    }>(
      `
        SELECT
          count(*) FILTER (
            WHERE "agent_run"."id" IS NOT NULL
              AND "zero_run"."id" IS NULL
          )::integer AS "agentOnly",
          count(*) FILTER (
            WHERE "zero_run"."id" IS NOT NULL
              AND "agent_run"."id" IS NULL
          )::integer AS "zeroOnly"
        FROM "agent_runs" AS "agent_run"
        FULL OUTER JOIN "zero_runs" AS "zero_run"
          ON "zero_run"."id" = "agent_run"."id"
        WHERE "agent_run"."user_id" = 'stage2-lock-probe-user'
           OR "zero_run"."id" = ANY($1::uuid[])
      `,
      [runIds],
    );
    return stranded.rows;
  }

  async function createSourceWriterPauseTrigger(client: Client): Promise<void> {
    await client.query(`
      CREATE OR REPLACE FUNCTION "stage2_lock_probe_pause_source_writer"()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(26972);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER "stage2_lock_probe_pause_source_writer"
      BEFORE UPDATE OF "summary" ON "zero_runs"
      FOR EACH ROW
      WHEN (NEW."summary" = 'new source value')
      EXECUTE FUNCTION "stage2_lock_probe_pause_source_writer"()
    `);
  }

  async function dropSourceWriterPauseTrigger(client: Client): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS "stage2_lock_probe_pause_source_writer"
      ON "zero_runs"
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS "stage2_lock_probe_pause_source_writer"()
    `);
  }

  const setup = await connect();
  await applyMigrationsFromDirectoryUpToTag(
    setup,
    migrationsDirectory,
    expansionMigration,
  );
  try {
    {
      const ids = await seed(setup, 1);
      const sourceWriter = await connect();
      const runner = await connect();
      const pauseController = await connect();
      try {
        await createSourceWriterPauseTrigger(setup);
        await pauseController.query("BEGIN");
        await pauseController.query(`SELECT pg_advisory_xact_lock(26972)`);
        const writerPid = await sourceWriter.query<{ pid: number }>(
          `SELECT pg_backend_pid() AS "pid"`,
        );
        const writing = sourceWriter.query(
          `UPDATE "zero_runs" SET "summary" = 'new source value' WHERE "id" = $1`,
          [ids[0]],
        );
        let sourceWriterPaused = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const activity = await setup.query<{ paused: boolean }>(
            `
              SELECT coalesce(
                "wait_event_type" = 'Lock'
                  AND "wait_event" = 'advisory',
                false
              ) AS "paused"
              FROM "pg_stat_activity"
              WHERE "pid" = $1
            `,
            [writerPid.rows[0]!.pid],
          );
          sourceWriterPaused = activity.rows[0]?.paused ?? false;
          if (sourceWriterPaused) break;
          await new Promise((resolve) => {
            return setTimeout(resolve, 10);
          });
        }
        assert.equal(sourceWriterPaused, true);
        await runner.query(`SET statement_timeout = '1s'`);
        await runner.query(backfillStatement);
        assert.equal(await mismatchCount(runner), 0);
        await pauseController.query("COMMIT");
        await writing;
        await runner.query(backfillStatement);
        assert.equal(await mismatchCount(runner), 0);
      } finally {
        await pauseController.query("ROLLBACK").catch(() => {
          return undefined;
        });
        await dropSourceWriterPauseTrigger(setup);
        await sourceWriter.end();
        await runner.end();
        await pauseController.end();
      }
    }

    {
      const ids = await seed(setup, 3);
      const promoter = await connect();
      const runner = await connect();
      try {
        await lockTarget(promoter, ids[0]!);
        await runner.query(
          `SET vm0.agent_run_metadata_backfill_no_progress_timeout = '1 second'`,
        );
        const running = runner.query(backfillStatement);
        await waitForMismatchCount(setup, 1);
        await promoter.query(
          `UPDATE "agent_runs" SET "status" = "status" WHERE "id" = $1`,
          [ids[0]],
        );
        await promoter.query(
          `UPDATE "zero_runs" SET "api_started_at" = '2026-08-13 01:02:03' WHERE "id" = $1`,
          [ids[0]],
        );
        await promoter.query("COMMIT");
        await running;
        assert.equal(await mismatchCount(runner), 0);
      } finally {
        await promoter.query("ROLLBACK").catch(() => {
          return undefined;
        });
        await promoter.end();
        await runner.end();
      }
    }

    {
      const ids = await seed(setup, 3);
      const deleter = await connect();
      const runner = await connect();
      try {
        await lockTarget(deleter, ids[0]!);
        await runner.query(
          `SET vm0.agent_run_metadata_backfill_no_progress_timeout = '1 second'`,
        );
        const running = runner.query(backfillStatement);
        await waitForMismatchCount(setup, 1);
        await deleter.query(`DELETE FROM "agent_runs" WHERE "id" = $1`, [
          ids[0],
        ]);
        await deleter.query("COMMIT");
        await running;
        assert.equal(await mismatchCount(runner), 0);
        assert.deepEqual(await readStrandedCount(runner, ids), [
          { agentOnly: 0, zeroOnly: 0 },
        ]);
      } finally {
        await deleter.query("ROLLBACK").catch(() => {
          return undefined;
        });
        await deleter.end();
        await runner.end();
      }
    }

    {
      const ids = await seed(setup, 502);
      const locker = await connect();
      const runner = await connect();
      try {
        await lockTarget(locker, ids[0]!);
        await runner.query(
          `SET vm0.agent_run_metadata_backfill_no_progress_timeout = '250ms'`,
        );
        await assert.rejects(
          runner.query(backfillStatement),
          /Stage 2 backfill made no progress for 00:00:00.25 while eligible rows remained/,
        );
        assert.equal(await mismatchCount(runner), 1);
        const committedTransactions = await runner.query<{ count: number }>(`
          SELECT count(*)::integer AS "count"
          FROM "zero_runs" AS "source"
          INNER JOIN "agent_runs" AS "target" ON "target"."id" = "source"."id"
          WHERE "target"."summary" IS NOT DISTINCT FROM "source"."summary"
            AND "target"."user_id" = 'stage2-lock-probe-user'
          GROUP BY "target"."xmin"::text
          ORDER BY "count"
        `);
        assert.deepEqual(committedTransactions.rows, [
          { count: 1 },
          { count: 500 },
        ]);
        const prematureLedgerRows = await runner.query<{ count: number }>(`
          SELECT count(*)::integer AS "count"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "created_at" > 1786617147388
        `);
        assert.deepEqual(prematureLedgerRows.rows, [{ count: 0 }]);

        await locker.query("COMMIT");
        await runner.query(backfillStatement);
        assert.equal(await mismatchCount(runner), 0);
        assert.deepEqual(await readStrandedCount(runner, ids), [
          { agentOnly: 0, zeroOnly: 0 },
        ]);
      } finally {
        await locker.query("ROLLBACK").catch(() => {
          return undefined;
        });
        await locker.end();
        await runner.end();
      }
    }
  } finally {
    await setup.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }

  console.log("stage2 lock probe passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentRunMetadataStage2LockDraft().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
