import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  acceptedAgentOnlyIds,
  assertProductionExceptionConstants,
  createCallbackFixtureExecutionSql,
  seedAcceptedAgentOnlyRows,
  seedAcceptedCallbacks,
  seedAgentRunFixtureParents,
  targetMetadataColumns,
} from "./agent-run-metadata-stage-2-test-fixtures";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const minimumLedgerTimestamp = 1786617147388;
const previousMigration = "0918_add_video_model_columns";
const expansionMigration = "0919_clammy_mastermind";
const testDatabase = "migration_agent_run_metadata_stage_2_preflight_draft";

interface MutationState {
  readonly agentDigest: string;
  readonly constraintCount: number;
  readonly indexCount: number;
  readonly ledgerCount: number | null;
  readonly ledgerMax: string | null;
  readonly ledgerPresent: boolean;
  readonly relationFileNode: string;
  readonly zeroDigest: string;
}

interface ShapeDrift {
  readonly column: string;
  readonly drift: string;
  readonly restore: string;
}

const acceptedLifecycleShapeDrifts: readonly ShapeDrift[] = [
  {
    column: "status",
    drift: `"status" = 'completed'`,
    restore: `"status" = 'failed'`,
  },
  {
    column: "created_at:lower",
    drift: `"created_at" = timestamp '2026-03-29 23:59:59.999999'`,
    restore: `"created_at" = timestamp '2026-04-01 00:00:00'`,
  },
  {
    column: "created_at:upper",
    drift: `"created_at" = timestamp '2026-04-09 00:00:00'`,
    restore: `"created_at" = timestamp '2026-04-01 00:00:00'`,
  },
  {
    column: "started_at",
    drift: `"started_at" = timestamp '2026-04-01 00:01:00'`,
    restore: `"started_at" = NULL`,
  },
  {
    column: "sandbox_id",
    drift: `"sandbox_id" = 'stage2-shape-drift'`,
    restore: `"sandbox_id" = NULL`,
  },
  {
    column: "last_event_sequence",
    drift: `"last_event_sequence" = 1`,
    restore: `"last_event_sequence" = NULL`,
  },
];

const acceptedMetadataShapeDrifts: readonly ShapeDrift[] = [
  {
    column: "trigger_source",
    drift: `"trigger_source" = 'chat'`,
    restore: `"trigger_source" = NULL`,
  },
  {
    column: "autonomy_budget",
    drift: `"autonomy_budget" = 1`,
    restore: `"autonomy_budget" = NULL`,
  },
  {
    column: "workflow_automation_id",
    drift: `"workflow_automation_id" = '00000000-0000-4000-8000-000000092491'`,
    restore: `"workflow_automation_id" = NULL`,
  },
  {
    column: "goal_id",
    drift: `"goal_id" = '00000000-0000-4000-8000-000000092492'`,
    restore: `"goal_id" = NULL`,
  },
  {
    column: "model_provider",
    drift: `"model_provider" = 'stage2-provider'`,
    restore: `"model_provider" = NULL`,
  },
  {
    column: "model_provider_id",
    drift: `"model_provider_id" = '00000000-0000-4000-8000-000000092493'`,
    restore: `"model_provider_id" = NULL`,
  },
  {
    column: "model_provider_credential_scope",
    drift: `"model_provider_credential_scope" = 'org'`,
    restore: `"model_provider_credential_scope" = NULL`,
  },
  {
    column: "selected_model",
    drift: `"selected_model" = 'stage2-model'`,
    restore: `"selected_model" = NULL`,
  },
  {
    column: "codex_service_tier",
    drift: `"codex_service_tier" = 'priority'`,
    restore: `"codex_service_tier" = NULL`,
  },
  {
    column: "selected_video_model",
    drift: `"selected_video_model" = 'stage2-video-model'`,
    restore: `"selected_video_model" = NULL`,
  },
  {
    column: "chat_thread_id",
    drift: `"chat_thread_id" = '00000000-0000-4000-8000-000000092494'`,
    restore: `"chat_thread_id" = NULL`,
  },
  {
    column: "api_started_at",
    drift: `"api_started_at" = timestamp '2026-04-01 00:02:00'`,
    restore: `"api_started_at" = NULL`,
  },
  {
    column: "first_assistant_event_acknowledged_at",
    drift: `"first_assistant_event_acknowledged_at" = timestamp '2026-04-01 00:03:00'`,
    restore: `"first_assistant_event_acknowledged_at" = NULL`,
  },
  {
    column: "summary",
    drift: `"summary" = 'stage2 summary drift'`,
    restore: `"summary" = NULL`,
  },
  {
    column: "trigger_brief",
    drift: `"trigger_brief" = 'stage2 trigger brief drift'`,
    restore: `"trigger_brief" = NULL`,
  },
];

const callbackShapeDrifts: readonly ShapeDrift[] = [
  {
    column: "status",
    drift: `"status" = 'pending'`,
    restore: `"status" = 'delivered'`,
  },
  {
    column: "attempts",
    drift: `"attempts" = 2`,
    restore: `"attempts" = 1`,
  },
  {
    column: "last_attempt_at",
    drift: `"last_attempt_at" = NULL`,
    restore: `"last_attempt_at" = timestamp '2026-04-01 00:01:00'`,
  },
  {
    column: "delivered_at",
    drift: `"delivered_at" = NULL`,
    restore: `"delivered_at" = timestamp '2026-04-01 00:02:00'`,
  },
  {
    column: "last_error",
    drift: `"last_error" = 'stage2 callback drift'`,
    restore: `"last_error" = NULL`,
  },
  {
    column: "internal_kind",
    drift: `"internal_kind" = 'stage2-callback-drift'`,
    restore: `"internal_kind" = NULL`,
  },
];

export async function validateAgentRunMetadataStage2PreflightDraft(): Promise<void> {
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
  const productionPreflight = statements[preflightIndex]!;
  assertProductionExceptionConstants(draft, 2);
  assertProductionExceptionConstants(productionPreflight, 1);

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
  try {
    const readMutationState = async (): Promise<MutationState> => {
      const ledgerRelation = await client.query<{ present: boolean }>(`
        SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
          AS "present"
      `);
      const ledgerPresent = ledgerRelation.rows[0]?.present ?? false;
      const ledger = ledgerPresent
        ? await client.query<{ count: number; maximum: string | null }>(`
            SELECT
              count(*)::integer AS "count",
              max("created_at")::text AS "maximum"
            FROM "drizzle"."__drizzle_migrations"
          `)
        : undefined;
      const state = await client.query<{
        agentDigest: string;
        constraintCount: number;
        indexCount: number;
        relationFileNode: string;
        zeroDigest: string;
      }>(`
        SELECT
          pg_relation_filenode('public.agent_runs'::regclass)::text
            AS "relationFileNode",
          md5(coalesce((
            SELECT string_agg(
              to_jsonb("agent_run")::text,
              ',' ORDER BY "agent_run"."id"
            )
            FROM "agent_runs" AS "agent_run"
          ), '')) AS "agentDigest",
          md5(coalesce((
            SELECT string_agg(
              to_jsonb("zero_run")::text,
              ',' ORDER BY "zero_run"."id"
            )
            FROM "zero_runs" AS "zero_run"
          ), '')) AS "zeroDigest",
          (
            SELECT count(*)::integer
            FROM "pg_class" AS "index_class"
            INNER JOIN "pg_namespace" AS "index_namespace"
              ON "index_namespace"."oid" = "index_class"."relnamespace"
            WHERE "index_namespace"."nspname" = 'public'
              AND "index_class"."relname" IN (
                'idx_agent_runs_chat_thread_id',
                'idx_agent_runs_workflow_automation',
                'idx_agent_runs_goal',
                'idx_agent_runs_chat_thread_id_stage2_invalid',
                'idx_agent_runs_workflow_automation_stage2_invalid',
                'idx_agent_runs_goal_stage2_invalid'
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
      const row = state.rows[0];
      assert.ok(row);
      return {
        ...row,
        ledgerCount: ledger?.rows[0]?.count ?? null,
        ledgerMax: ledger?.rows[0]?.maximum ?? null,
        ledgerPresent,
      };
    };

    const resetSession = async (): Promise<void> => {
      await client.query("ROLLBACK");
      await client.query("RESET lock_timeout");
      await client.query("RESET statement_timeout");
    };

    const runPreflightStart = async (): Promise<void> => {
      for (const statement of statements.slice(0, preflightIndex)) {
        await client.query(statement);
      }
    };

    const expectPreflightFailure = async (
      expected: RegExp,
      preflight = productionPreflight,
    ): Promise<void> => {
      const before = await readMutationState();
      await runPreflightStart();
      await assert.rejects(client.query(preflight), expected);
      await resetSession();
      assert.deepEqual(await readMutationState(), before);
    };

    const runPreflightSuccess = async (
      preflight = productionPreflight,
    ): Promise<string[]> => {
      const notices: string[] = [];
      const listener = (notice: { message?: string }): void => {
        if (notice.message) notices.push(notice.message);
      };
      client.on("notice", listener);
      try {
        const before = await readMutationState();
        await runPreflightStart();
        await client.query(preflight);
        await client.query(statements[preflightIndex + 1]!);
        await client.query("RESET lock_timeout");
        await client.query("RESET statement_timeout");
        assert.deepEqual(await readMutationState(), before);
        return notices;
      } finally {
        client.off("notice", listener);
      }
    };

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await expectPreflightFailure(
      /Stage 2 preflight requires migration ledger timestamp >= 1786617147388, found /,
    );

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
    const pristineNotices = await runPreflightSuccess();
    assert.ok(
      pristineNotices.some((notice) => {
        return notice.includes(
          "agent_runs=0, zero_runs=0, paired=0, zero_only=0",
        );
      }),
    );

    await client.query(`ALTER SCHEMA "drizzle" RENAME TO "drizzle_missing"`);
    await expectPreflightFailure(
      /relation "drizzle.__drizzle_migrations" does not exist/,
    );
    await client.query(`ALTER SCHEMA "drizzle_missing" RENAME TO "drizzle"`);

    await client.query(`
      ALTER TABLE "drizzle"."__drizzle_migrations"
      RENAME TO "__drizzle_migrations_missing"
    `);
    await expectPreflightFailure(
      /relation "drizzle.__drizzle_migrations" does not exist/,
    );
    await client.query(`
      ALTER TABLE "drizzle"."__drizzle_migrations_missing"
      RENAME TO "__drizzle_migrations"
    `);

    await client.query(`
      ALTER TABLE "zero_runs"
      DISABLE TRIGGER "sync_zero_run_metadata_to_agent_runs"
    `);
    await expectPreflightFailure(
      /Stage 2 preflight found 0 exact enabled Stage 1 bridge triggers/,
    );
    await client.query(`
      ALTER TABLE "zero_runs"
      ENABLE TRIGGER "sync_zero_run_metadata_to_agent_runs"
    `);

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
    await expectPreflightFailure(
      /Stage 2 preflight inbound agent_runs FK definitions drifted: expected 20, found 20/,
    );
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

    await client.query(`
      CREATE TABLE "stage2_unexpected_inbound_fk" (
        "run_id" uuid REFERENCES "agent_runs"("id") ON DELETE CASCADE
      )
    `);
    await expectPreflightFailure(
      /Stage 2 preflight inbound agent_runs FK definitions drifted: expected 20, found 21/,
    );
    await client.query(`DROP TABLE "stage2_unexpected_inbound_fk"`);

    await client.query(`
      ALTER TABLE "chat_event_search_messages"
      RENAME COLUMN "run_id" TO "missing_run_id"
    `);
    await expectPreflightFailure(
      /Stage 2 preflight non-FK run-attribution definitions drifted: expected 14, found 14/,
    );
    await client.query(`
      ALTER TABLE "chat_event_search_messages"
      RENAME COLUMN "missing_run_id" TO "run_id"
    `);

    await client.query(`
      ALTER TABLE "chat_event_search_messages"
      ADD COLUMN "unexpected_run_id" uuid
    `);
    await expectPreflightFailure(
      /Stage 2 preflight non-FK run-attribution definitions drifted: expected 14, found 15/,
    );
    await client.query(`
      ALTER TABLE "chat_event_search_messages"
      DROP COLUMN "unexpected_run_id"
    `);

    await client.query(`SET session_replication_role = 'replica'`);
    await client.query(`
      INSERT INTO "zero_runs" ("id", "trigger_source")
      VALUES ('00000000-0000-4000-8000-000000092401', 'chat')
    `);
    await client.query(`RESET session_replication_role`);
    await expectPreflightFailure(
      /Stage 2 preflight found 1 zero_runs-only rows/,
    );
    await client.query(`SET session_replication_role = 'replica'`);
    await client.query(`
      DELETE FROM "zero_runs"
      WHERE "id" = '00000000-0000-4000-8000-000000092401'
    `);
    await client.query(`RESET session_replication_role`);

    await seedAgentRunFixtureParents(client);
    await client.query(`
      INSERT INTO "agent_runs" (
        "id", "status", "prompt", "user_id", "org_id", "session_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000092402',
        'failed', 'unexpected one-sided fixture',
        'stage2-migration-fixture-user', 'stage2-migration-fixture-org',
        '00000000-0000-4000-8000-000000092201'
      )
    `);
    await expectPreflightFailure(
      /Stage 2 preflight agent_runs-only set mismatch: count 1, digest /,
    );
    await client.query(`
      DELETE FROM "agent_runs"
      WHERE "id" = '00000000-0000-4000-8000-000000092402'
    `);

    await seedAcceptedAgentOnlyRows(client);
    await expectPreflightFailure(
      /Stage 2 preflight callback exception mismatch: count 0, run_count 0, digest <NULL>, invalid_shape 0/,
    );
    const fixtureCallbackDigest = await seedAcceptedCallbacks(client);
    await expectPreflightFailure(
      new RegExp(
        `Stage 2 preflight callback exception mismatch: count 12, run_count 10, digest ${fixtureCallbackDigest}, invalid_shape 0`,
      ),
    );
    const fixturePreflight = createCallbackFixtureExecutionSql(
      productionPreflight,
      fixtureCallbackDigest,
      1,
    );
    await runPreflightSuccess(fixturePreflight);

    assert.deepEqual(
      acceptedLifecycleShapeDrifts.map(({ column }) => {
        return column;
      }),
      [
        "status",
        "created_at:lower",
        "created_at:upper",
        "started_at",
        "sandbox_id",
        "last_event_sequence",
      ],
    );
    assert.deepEqual(
      acceptedMetadataShapeDrifts.map(({ column }) => {
        return column;
      }),
      [...targetMetadataColumns],
    );
    assert.deepEqual(
      callbackShapeDrifts.map(({ column }) => {
        return column;
      }),
      [
        "status",
        "attempts",
        "last_attempt_at",
        "delivered_at",
        "last_error",
        "internal_kind",
      ],
    );

    for (const shapeDrift of [
      ...acceptedLifecycleShapeDrifts,
      ...acceptedMetadataShapeDrifts,
    ]) {
      await client.query(
        `
          UPDATE "agent_runs"
          SET ${shapeDrift.drift}
          WHERE "id" = $1
        `,
        [acceptedAgentOnlyIds[0]],
      );
      await expectPreflightFailure(
        /Stage 2 preflight found 1 accepted lifecycle rows with shape drift/,
        fixturePreflight,
      );
      await client.query(
        `
          UPDATE "agent_runs"
          SET ${shapeDrift.restore}
          WHERE "id" = $1
        `,
        [acceptedAgentOnlyIds[0]],
      );
    }

    for (const shapeDrift of callbackShapeDrifts) {
      await client.query(`
        UPDATE "agent_run_callbacks"
        SET ${shapeDrift.drift}
        WHERE "id" = (
          SELECT "id" FROM "agent_run_callbacks" ORDER BY "id" LIMIT 1
        )
      `);
      await expectPreflightFailure(
        new RegExp(
          `Stage 2 preflight callback exception mismatch: count 12, run_count 10, digest ${fixtureCallbackDigest}, invalid_shape 1`,
        ),
        fixturePreflight,
      );
      await client.query(`
        UPDATE "agent_run_callbacks"
        SET ${shapeDrift.restore}
        WHERE "id" = (
          SELECT "id" FROM "agent_run_callbacks" ORDER BY "id" LIMIT 1
        )
      `);
    }

    await client.query(`
      INSERT INTO "agent_runs" (
        "id", "status", "prompt", "user_id", "org_id", "session_id"
      ) VALUES (
        '00000000-0000-4000-8000-000000092403',
        'pending', 'invalid source fixture',
        'stage2-migration-fixture-user', 'stage2-migration-fixture-org',
        '00000000-0000-4000-8000-000000092201'
      )
    `);
    await client.query(`
      INSERT INTO "zero_runs" ("id", "trigger_source")
      VALUES ('00000000-0000-4000-8000-000000092403', 'chat')
    `);
    await client.query(`SET session_replication_role = 'replica'`);
    await client.query(`
      UPDATE "zero_runs"
      SET "goal_id" = '00000000-0000-4000-8000-000000092499'
      WHERE "id" = '00000000-0000-4000-8000-000000092403'
    `);
    await client.query(`RESET session_replication_role`);
    await expectPreflightFailure(
      /Stage 2 preflight found 1 structurally invalid zero_runs rows/,
      fixturePreflight,
    );
    await client.query(`
      DELETE FROM "agent_runs"
      WHERE "id" = '00000000-0000-4000-8000-000000092403'
    `);

    await client.query(
      `
      INSERT INTO "agent_run_queue" (
        "run_id", "user_id", "org_id", "expires_at"
      ) VALUES ($1, 'stage2-migration-fixture-user',
        'stage2-migration-fixture-org', now() + interval '1 hour')
    `,
      [acceptedAgentOnlyIds[0]],
    );
    await expectPreflightFailure(
      /Stage 2 preflight found 1 unexpected FK-backed dependencies/,
      fixturePreflight,
    );
    await client.query(`DELETE FROM "agent_run_queue" WHERE "run_id" = $1`, [
      acceptedAgentOnlyIds[0],
    ]);

    await client.query(
      `
      INSERT INTO "archived_task_runs" (
        "user_id", "org_id", "task_id", "task_type", "archived_run_id"
      ) VALUES (
        'stage2-migration-fixture-user', 'stage2-migration-fixture-org',
        'stage2-task', 'stage2-fixture', $1
      )
    `,
      [acceptedAgentOnlyIds[0]],
    );
    await expectPreflightFailure(
      /Stage 2 preflight found 1 unexpected non-FK dependencies/,
      fixturePreflight,
    );
    await client.query(`
      DELETE FROM "archived_task_runs"
      WHERE "task_id" = 'stage2-task'
    `);
    await runPreflightSuccess(fixturePreflight);
  } finally {
    await client.query("ROLLBACK").catch(() => {
      return undefined;
    });
    await client.query("RESET session_replication_role").catch(() => {
      return undefined;
    });
    await client.query("RESET lock_timeout").catch(() => {
      return undefined;
    });
    await client.query("RESET statement_timeout").catch(() => {
      return undefined;
    });
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }

  console.log("stage2 preflight probe passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentRunMetadataStage2PreflightDraft().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
