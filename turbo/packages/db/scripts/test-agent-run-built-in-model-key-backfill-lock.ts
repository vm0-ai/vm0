import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

export const AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME =
  "backfill_agent_run_built_in_model_key_ids_0973";

interface BackfillLockFixture {
  readonly orgId: string;
  readonly sessionId: string;
  readonly userId: string;
}

async function seedLegacyOnlyRows(
  client: Client,
  fixture: BackfillLockFixture,
  count: number,
  prompt: string,
): Promise<string[]> {
  const runIds = Array.from({ length: count }, () => {
    return randomUUID();
  }).sort();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "trigger_source", "autonomy_budget", "vm0_model_key_id"
        )
        SELECT
          "run_id", $2, $3, $4, 'pending', $5, 'chat', 0, "run_id"
        FROM unnest($1::uuid[]) AS "fixture_row"("run_id")
      `,
      [runIds, fixture.userId, fixture.orgId, fixture.sessionId, prompt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return runIds;
}

async function eligibleRowCount(
  client: Client,
  runIds: readonly string[],
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT count(*)::integer AS "count"
      FROM "agent_runs"
      WHERE "id" = ANY($1::uuid[])
        AND "vm0_model_key_id" IS NOT NULL
        AND "built_in_model_key_id" IS NULL
    `,
    [runIds],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function waitForEligibleRowCount(
  client: Client,
  runIds: readonly string[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await eligibleRowCount(client, runIds)) === expectedCount) return;
    await new Promise((resolve) => {
      return setTimeout(resolve, 10);
    });
  }
  assert.equal(await eligibleRowCount(client, runIds), expectedCount);
}

async function lockAgentRun(client: Client, runId: string): Promise<void> {
  await client.query("BEGIN");
  await client.query(`SELECT 1 FROM "agent_runs" WHERE "id" = $1 FOR UPDATE`, [
    runId,
  ]);
}

async function connect(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

export async function agentRunModelKeyBackfillProcedureCount(
  client: Client,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT count(*)::integer AS "count"
      FROM "pg_catalog"."pg_proc" AS "function_row"
      WHERE "function_row"."pronamespace" = 'public'::regnamespace
        AND "function_row"."proname" = $1
        AND pg_catalog.pg_get_function_identity_arguments(
          "function_row"."oid"
        ) = 'p_no_progress_timeout interval'
    `,
    [AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

export async function validateAgentRunBuiltInModelKeyBackfillLockRetryAndTimeout(
  databaseUrl: string,
  fixture: BackfillLockFixture,
  procedure: string,
): Promise<void> {
  const setup = await connect(databaseUrl);
  await setup.query(procedure);
  try {
    {
      const runIds = await seedLegacyOnlyRows(
        setup,
        fixture,
        3,
        "backfill lock retry",
      );
      const locker = await connect(databaseUrl);
      const runner = await connect(databaseUrl);
      try {
        await lockAgentRun(locker, runIds[0]!);
        const running = runner.query(
          `CALL "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(interval '1 second')`,
        );
        await waitForEligibleRowCount(setup, runIds, 1);
        await locker.query("COMMIT");
        await running;
        assert.equal(await eligibleRowCount(setup, runIds), 0);
      } finally {
        await locker.query("ROLLBACK").catch(() => {
          return undefined;
        });
        await locker.end();
        await runner.end();
        await setup.query(
          `DELETE FROM "agent_runs" WHERE "id" = ANY($1::uuid[])`,
          [runIds],
        );
      }
    }

    {
      const runIds = await seedLegacyOnlyRows(
        setup,
        fixture,
        502,
        "backfill lock timeout",
      );
      const locker = await connect(databaseUrl);
      const runner = await connect(databaseUrl);
      try {
        await lockAgentRun(locker, runIds[0]!);
        await assert.rejects(
          runner.query(
            `CALL "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(interval '250 milliseconds')`,
          ),
          /Agent Run model key backfill made no progress for 00:00:00.25 while eligible rows remained/u,
        );
        assert.equal(await eligibleRowCount(setup, runIds), 1);
        const committedBatches = await setup.query<{ count: number }>(
          `
            SELECT count(*)::integer AS "count"
            FROM "agent_runs"
            WHERE "id" = ANY($1::uuid[])
              AND "built_in_model_key_id" IS NOT NULL
            GROUP BY "xmin"::text
            ORDER BY "count"
          `,
          [runIds],
        );
        assert.deepEqual(committedBatches.rows, [{ count: 1 }, { count: 500 }]);

        await locker.query("COMMIT");
        await runner.query(
          `CALL "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(interval '30 seconds')`,
        );
        assert.equal(await eligibleRowCount(setup, runIds), 0);
      } finally {
        await locker.query("ROLLBACK").catch(() => {
          return undefined;
        });
        await locker.end();
        await runner.end();
        await setup.query(
          `DELETE FROM "agent_runs" WHERE "id" = ANY($1::uuid[])`,
          [runIds],
        );
      }
    }
  } finally {
    await setup.query(
      `DROP PROCEDURE IF EXISTS "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(interval)`,
    );
    assert.equal(await agentRunModelKeyBackfillProcedureCount(setup), 0);
    await setup.end();
  }
}
