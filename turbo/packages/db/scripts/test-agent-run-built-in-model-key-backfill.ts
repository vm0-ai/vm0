import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

export const AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME =
  "backfill_agent_run_built_in_model_key_ids_0973";

interface AgentRunModelKeyBridgeIdentity {
  readonly functionBodyHash: string;
  readonly triggerDefinition: string;
}

export function agentRunModelKeyBackfillProcedureStatement(
  statements: readonly string[],
): string {
  const procedure = statements.find((statement) => {
    return statement.includes(
      `CREATE OR REPLACE PROCEDURE "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(`,
    );
  });
  assert.ok(procedure);
  return procedure;
}

function requiredStatement(
  statements: readonly string[],
  marker: string,
): string {
  const statement = statements.find((candidate) => {
    return candidate.includes(marker);
  });
  assert.ok(statement);
  return statement;
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function validateBackfillPreflight(
  statements: readonly string[],
  procedure: string,
  bridgeIdentity: AgentRunModelKeyBridgeIdentity,
): void {
  const preflight = requiredStatement(
    statements,
    "Agent Run model key backfill requires the accepted enabled 0971 bridge",
  );
  assert.ok(
    statements.indexOf(preflight) < statements.indexOf(procedure),
    "the fail-closed preflight must run before the backfill procedure",
  );
  assert.ok(preflight.includes(bridgeIdentity.triggerDefinition));
  assert.ok(preflight.includes(bridgeIdentity.functionBodyHash));
  assert.match(preflight, /"trigger_row"\."tgenabled" = 'O'/u);
  assert.match(
    preflight,
    /"vm0_model_key_id" IS NULL\s+AND "built_in_model_key_id" IS NOT NULL/u,
  );
  assert.match(
    preflight,
    /"vm0_model_key_id" IS NOT NULL\s+AND "built_in_model_key_id" IS NOT NULL\s+AND "vm0_model_key_id" IS DISTINCT FROM "built_in_model_key_id"/u,
  );
}

function validateBackfillProcedure(
  statements: readonly string[],
  procedure: string,
): void {
  const batchStatement = procedure.match(
    /WITH "batch" AS MATERIALIZED \(([\s\S]*?)\),\s*"updated" AS \(([\s\S]*?)\)\s*SELECT/u,
  );
  assert.ok(batchStatement);
  const candidateSql = batchStatement[1]!;
  const updateSql = batchStatement[2]!;
  assert.match(
    candidateSql,
    /WHERE \(v_scan_after IS NULL OR "candidate"\."id" > v_scan_after\)\s+AND "candidate"\."vm0_model_key_id" IS NOT NULL\s+AND "candidate"\."built_in_model_key_id" IS NULL/u,
  );
  assert.match(
    candidateSql,
    /ORDER BY "candidate"\."id"\s+LIMIT 500\s+FOR UPDATE OF "candidate" SKIP LOCKED/u,
  );
  assert.match(
    updateSql,
    /UPDATE "agent_runs" AS "target"\s+SET "built_in_model_key_id" = "batch"\."vm0_model_key_id"\s+FROM "batch"/u,
  );
  assert.match(
    updateSql,
    /WHERE "target"\."id" = "batch"\."id"\s+AND "target"\."vm0_model_key_id" IS NOT NULL\s+AND "target"\."built_in_model_key_id" IS NULL/u,
  );
  assert.equal(
    countOccurrences(procedure, 'UPDATE "agent_runs" AS "target"'),
    1,
  );
  assert.equal((procedure.match(/\bCOMMIT;/gu) ?? []).length, 1);
  assert.match(
    procedure,
    /COMMIT;\s+SET LOCAL lock_timeout = '1s';\s+SET LOCAL transaction_timeout = '5min';/u,
  );
  assert.equal(countOccurrences(procedure, "PERFORM pg_sleep(0.05);"), 2);
  assert.match(procedure, /v_updated_ids IS DISTINCT FROM v_batch_ids/u);
  assert.match(procedure, /p_no_progress_timeout > interval '30 seconds'/u);
  assert.match(
    procedure,
    /Agent Run model key backfill made no progress for % while eligible rows remained/u,
  );
  assert.equal(
    statements.includes(
      `CALL "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(interval '30 seconds');`,
    ),
    true,
  );
  assert.equal(
    statements.includes(
      `DROP PROCEDURE IF EXISTS "${AGENT_RUN_MODEL_KEY_BACKFILL_PROCEDURE_NAME}"(interval);`,
    ),
    true,
  );
}

function validateBackfillFinalAssertions(
  statements: readonly string[],
  bridgeIdentity: AgentRunModelKeyBridgeIdentity,
): void {
  const finalAssertions = requiredStatement(
    statements,
    "Agent Run model key backfill procedure still exists",
  );
  for (const assertion of [
    "Agent Run model key backfill left legacy-only rows",
    "Agent Run model key backfill left canonical-only rows",
    "Agent Run model key backfill left unequal dual rows",
    "Agent Run model key backfill did not preserve the accepted enabled 0971 bridge",
    "Agent Run model key backfill procedure still exists",
  ]) {
    assert.ok(finalAssertions.includes(assertion));
  }
  assert.ok(finalAssertions.includes(bridgeIdentity.triggerDefinition));
  assert.ok(finalAssertions.includes(bridgeIdentity.functionBodyHash));
  assert.match(finalAssertions, /to_regprocedure\(/u);
}

function validateBackfillMutationSurface(
  migrationSql: string,
  statements: readonly string[],
): void {
  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.doesNotMatch(executableSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(
    executableSql,
    /ALTER\s+TABLE\s+(?:public\.)?"?agent_runs"?/iu,
  );
  assert.doesNotMatch(
    executableSql,
    /\b(?:INSERT INTO|DELETE FROM|TRUNCATE)\s+(?:public\.)?"?agent_runs"?/iu,
  );
  for (const statement of statements) {
    const executableStatement = statement.replace(
      /^(?:--[^\n]*(?:\n|$)\s*)+/u,
      "",
    );
    assert.doesNotMatch(
      executableStatement,
      /^(?:ALTER\s+TABLE[\s\S]*?(?:DISABLE|ENABLE)\s+TRIGGER|(?:CREATE|REPLACE|DROP)\s+(?:TRIGGER|FUNCTION)\s+"?sync_agent_run_model_key_ids_0971)/iu,
    );
  }
  assert.doesNotMatch(executableSql, /\b2325\b/u);
}

export function validateAgentRunBuiltInModelKeyBackfillMigrationSql(
  migrationSql: string,
  statements: readonly string[],
  bridgeIdentity: AgentRunModelKeyBridgeIdentity,
): void {
  assert.equal(statements.length, 13);
  assert.match(statements[0] ?? "", /^-- vm0:non-transactional/mu);
  const procedure = agentRunModelKeyBackfillProcedureStatement(statements);
  validateBackfillPreflight(statements, procedure, bridgeIdentity);
  validateBackfillProcedure(statements, procedure);
  validateBackfillFinalAssertions(statements, bridgeIdentity);
  validateBackfillMutationSurface(migrationSql, statements);
}

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
