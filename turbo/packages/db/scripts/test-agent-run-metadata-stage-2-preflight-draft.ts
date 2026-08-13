import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const minimumLedgerTimestamp = 1786617147388;
const previousMigration = "0918_add_video_model_columns";
const expansionMigration = "0919_clammy_mastermind";
const testDatabase = "migration_agent_run_metadata_stage_2_preflight_draft";

interface MutationState {
  readonly constraintCount: number;
  readonly indexCount: number;
  readonly relationFileNode: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
  const draft = await fs.readFile(
    path.join(scriptDirectory, "agent-run-metadata-stage-2-draft.sql"),
    "utf8",
  );
  const statements = draft
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  const preflightIndex = statements.findIndex((statement) => {
    return statement.includes(
      "Stage 2 preflight requires migration ledger timestamp",
    );
  });
  assert.equal(preflightIndex, 4);

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({ connectionString: testUrl.toString() });
  await client.connect();
  let fkDriftInstalled = false;
  try {
    const readMutationState = async (): Promise<MutationState[]> => {
      const state = await client.query<MutationState>(`
        SELECT
          pg_relation_filenode('public.agent_runs'::regclass)::text
            AS "relationFileNode",
          (
            SELECT count(*)::integer
            FROM "pg_class" AS "index_class"
            INNER JOIN "pg_namespace" AS "index_namespace"
              ON "index_namespace"."oid" = "index_class"."relnamespace"
            WHERE "index_namespace"."nspname" = 'public'
              AND "index_class"."relname" IN (
                'idx_agent_runs_chat_thread_id',
                'idx_agent_runs_workflow_automation',
                'idx_agent_runs_goal'
              )
          ) AS "indexCount",
          (
            SELECT count(*)::integer
            FROM "pg_constraint"
            WHERE "conrelid" = 'public.agent_runs'::regclass
              AND "conname" IN (
                'agent_runs_chat_thread_id_chat_threads_id_fk',
                'agent_runs_workflow_automation_id_zero_workflow_automations_id_',
                'agent_runs_goal_id_thread_goals_id_fk',
                'agent_runs_autonomy_budget_check'
              )
          ) AS "constraintCount"
      `);
      return state.rows;
    };

    const runPreflightStart = async (): Promise<void> => {
      for (const statement of statements.slice(0, preflightIndex)) {
        await client.query(statement);
      }
    };

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    const beforeExpansion = await readMutationState();
    await runPreflightStart();
    await assert.rejects(
      client.query(statements[preflightIndex]!),
      /Stage 2 preflight requires migration ledger timestamp >= 1786617147388, found /,
    );
    await client.query("ROLLBACK");
    assert.deepEqual(await readMutationState(), beforeExpansion);
    await client.query("RESET lock_timeout");
    await client.query("RESET statement_timeout");

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );
    const ledger = await client.query<{ createdAt: string }>(`
      SELECT max("created_at")::text AS "createdAt"
      FROM "drizzle"."__drizzle_migrations"
    `);
    assert.deepEqual(ledger.rows, [
      { createdAt: minimumLedgerTimestamp.toString() },
    ]);
    const afterExpansion = await readMutationState();
    await runPreflightStart();
    await client.query(statements[preflightIndex]!);
    await client.query(statements[preflightIndex + 1]!);
    assert.deepEqual(await readMutationState(), afterExpansion);

    await client.query(`
      ALTER TABLE "browser_sessions"
      DROP CONSTRAINT "browser_sessions_run_id_agent_runs_id_fk"
    `);
    await client.query(`
      ALTER TABLE "browser_sessions"
      ADD CONSTRAINT "browser_sessions_run_id_agent_runs_id_fk"
      FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id")
      ON DELETE CASCADE
    `);
    fkDriftInstalled = true;
    await runPreflightStart();
    await assert.rejects(
      client.query(statements[preflightIndex]!),
      /Stage 2 preflight inbound agent_runs FK definitions drifted: expected 20, found 20/,
    );
    await client.query("ROLLBACK");
    assert.deepEqual(await readMutationState(), afterExpansion);
  } finally {
    await client.query("ROLLBACK").catch(() => {return undefined});
    if (fkDriftInstalled) {
      await client.query(`
        ALTER TABLE "browser_sessions"
        DROP CONSTRAINT "browser_sessions_run_id_agent_runs_id_fk"
      `);
      await client.query(`
        ALTER TABLE "browser_sessions"
        ADD CONSTRAINT "browser_sessions_run_id_agent_runs_id_fk"
        FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id")
        ON DELETE SET NULL
      `);
    }
    await client.query("RESET lock_timeout").catch(() => {return undefined});
    await client.query("RESET statement_timeout").catch(() => {return undefined});
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }

  console.log("stage2 preflight ledger probe passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
