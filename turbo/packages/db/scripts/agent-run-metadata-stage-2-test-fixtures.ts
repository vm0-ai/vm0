import assert from "node:assert/strict";
import type { Client } from "pg";

export const productionAgentOnlyDigest = "4418a1e0da8c1a2c34563a996d4b337c";
export const productionCallbackDigest = "408462129a863fe84c3b51c9d6e6951b";
export const stage2Migration = "0921_agent_run_metadata_stage_2";

export const acceptedAgentOnlyIds = [
  "0cad9bdf-0238-4c82-82f8-3299c5442fcc",
  "1273ff1c-b25d-4c2f-9a2f-9d1746e3ccb6",
  "5085b4b7-6f05-4712-9cc6-7da547edc8cc",
  "515ac92c-e18c-45bb-ae29-2b19c7dc5868",
  "5cb04070-8942-4cb3-b810-1ff9cb2b6e2b",
  "5fa8690b-9507-4607-a035-68308b825f4e",
  "6078841a-4b2d-414f-a175-31fa8db03fcc",
  "89f5a328-cc73-4621-aadb-253c36d9d35f",
  "8a30f583-7265-49c5-a434-c535c717caf7",
  "9180c355-3a06-4efb-817e-866bf3bfaeac",
  "9a3318e9-4a7e-4fc1-a204-0c5649159915",
  "9be063a5-5388-4420-92fc-068e6f790b9e",
  "b64e8f0b-c435-41a5-a34c-9226701a853e",
  "c47d7c7e-3ee9-4393-9154-0bc791c75564",
  "c564e0c2-ff22-4891-9326-bfe2b641050d",
  "dc3c2273-d4d3-4f9c-8709-a0d0d1c3f540",
] as const;

const fixtureCallbackIds = [
  "00000000-0000-4000-8000-000000092301",
  "00000000-0000-4000-8000-000000092302",
  "00000000-0000-4000-8000-000000092303",
  "00000000-0000-4000-8000-000000092304",
  "00000000-0000-4000-8000-000000092305",
  "00000000-0000-4000-8000-000000092306",
  "00000000-0000-4000-8000-000000092307",
  "00000000-0000-4000-8000-000000092308",
  "00000000-0000-4000-8000-000000092309",
  "00000000-0000-4000-8000-00000009230a",
  "00000000-0000-4000-8000-00000009230b",
  "00000000-0000-4000-8000-00000009230c",
] as const;

const composeId = "00000000-0000-4000-8000-000000092200";
const sessionId = "00000000-0000-4000-8000-000000092201";
const fixtureUserId = "stage2-migration-fixture-user";
const fixtureOrgId = "stage2-migration-fixture-org";
export const productionBackfillCall = `CALL "backfill_agent_run_metadata_stage2"(interval '30 seconds');`;
const productionTransactionTimeout = "SET LOCAL transaction_timeout = '5min';";
const fixtureTransactionTimeout = "SET LOCAL transaction_timeout = '1s';";

type BackfillTestTimeout = "1 second" | "250 milliseconds";

export const targetMetadataColumns = [
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
] as const;

export async function seedAgentRunFixtureParents(
  client: Client,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'stage2-migration-fixture', $3)
      ON CONFLICT ("id") DO NOTHING
    `,
    [composeId, fixtureUserId, fixtureOrgId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT ("id") DO NOTHING
    `,
    [sessionId, fixtureUserId, fixtureOrgId, composeId],
  );
}

export async function seedAcceptedAgentOnlyRows(client: Client): Promise<void> {
  await seedAgentRunFixtureParents(client);
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "status", "prompt", "created_at", "user_id", "org_id",
        "session_id"
      )
      SELECT
        "id", 'failed', 'accepted lifecycle-only fixture',
        timestamp '2026-04-01 00:00:00', $2, $3, $4
      FROM unnest($1::uuid[]) AS "accepted"("id")
    `,
    [acceptedAgentOnlyIds, fixtureUserId, fixtureOrgId, sessionId],
  );
}

export async function seedAcceptedCallbacks(client: Client): Promise<string> {
  await client.query(
    `
      INSERT INTO "agent_run_callbacks" (
        "id", "run_id", "status", "attempts", "last_attempt_at",
        "delivered_at"
      )
      SELECT
        "callback"."id",
        ($2::uuid[])[(("callback"."position" - 1) % 10) + 1],
        'delivered',
        1,
        timestamp '2026-04-01 00:01:00',
        timestamp '2026-04-01 00:02:00'
      FROM unnest($1::uuid[]) WITH ORDINALITY
        AS "callback"("id", "position")
    `,
    [fixtureCallbackIds, acceptedAgentOnlyIds],
  );
  const digest = await client.query<{ digest: string }>(
    `
    SELECT md5(string_agg("id"::text, ',' ORDER BY "id")) AS "digest"
    FROM "agent_run_callbacks"
    WHERE "id" = ANY($1::uuid[])
  `,
    [fixtureCallbackIds],
  );
  const value = digest.rows[0]?.digest;
  assert.ok(value);
  assert.notEqual(value, productionCallbackDigest);
  return value;
}

export async function seedPairedMetadataMismatches(
  client: Client,
  count: number,
): Promise<string[]> {
  await seedAgentRunFixtureParents(client);
  const inserted = await client.query<{ id: string }>(
    `
      WITH "fixture" AS (
        SELECT
          (
            substr(md5('stage2-paired-' || "position"), 1, 8) || '-' ||
            substr(md5('stage2-paired-' || "position"), 9, 4) || '-4' ||
            substr(md5('stage2-paired-' || "position"), 14, 3) || '-8' ||
            substr(md5('stage2-paired-' || "position"), 18, 3) || '-' ||
            substr(md5('stage2-paired-' || "position"), 21, 12)
          )::uuid AS "id",
          "position"
        FROM generate_series(1, $1::integer) AS "series"("position")
      ),
      "inserted_agent_run" AS (
        INSERT INTO "agent_runs" (
          "id", "status", "prompt", "user_id", "org_id", "session_id"
        )
        SELECT
          "id", 'pending', 'stage2 paired fixture', $2, $3, $4
        FROM "fixture"
        RETURNING "id"
      )
      INSERT INTO "zero_runs" (
        "id", "trigger_source", "autonomy_budget", "model_provider",
        "model_provider_id", "model_provider_credential_scope",
        "selected_model", "codex_service_tier", "selected_video_model",
        "api_started_at", "first_assistant_event_acknowledged_at",
        "summary", "trigger_brief"
      )
      SELECT
        "id", 'chat', 6, 'fixture-provider',
        '00000000-0000-4000-8000-000000092299', 'org',
        'fixture-model', 'priority', 'fixture-video-model',
        timestamp '2026-08-13 01:02:03',
        timestamp '2026-08-13 01:02:04',
        'fixture summary', 'fixture trigger brief'
      FROM "inserted_agent_run"
      RETURNING "id"::text AS "id"
    `,
    [count, fixtureUserId, fixtureOrgId, sessionId],
  );
  await client.query(
    `
    UPDATE "agent_runs"
    SET
      "trigger_source" = NULL,
      "autonomy_budget" = NULL,
      "workflow_automation_id" = NULL,
      "goal_id" = NULL,
      "model_provider" = NULL,
      "model_provider_id" = NULL,
      "model_provider_credential_scope" = NULL,
      "selected_model" = NULL,
      "codex_service_tier" = NULL,
      "selected_video_model" = NULL,
      "chat_thread_id" = NULL,
      "api_started_at" = NULL,
      "first_assistant_event_acknowledged_at" = NULL,
      "summary" = NULL,
      "trigger_brief" = NULL
    WHERE "user_id" = $1
      AND "prompt" = 'stage2 paired fixture'
  `,
    [fixtureUserId],
  );
  return inserted.rows
    .map(({ id }) => {
      return id;
    })
    .sort();
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

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

export function createBackfillTimeoutExecutionSql(
  productionSql: string,
  timeout: BackfillTestTimeout,
): string {
  assert.equal(countOccurrences(productionSql, productionBackfillCall), 1);
  const fixtureCall = `CALL "backfill_agent_run_metadata_stage2"(interval '${timeout}');`;
  assert.equal(countOccurrences(productionSql, fixtureCall), 0);

  const executionSql = productionSql.replace(
    productionBackfillCall,
    fixtureCall,
  );
  assert.equal(countOccurrences(executionSql, productionBackfillCall), 0);
  assert.equal(countOccurrences(executionSql, fixtureCall), 1);
  return executionSql;
}

export function createTransactionTimeoutExecutionSql(
  productionSql: string,
): string {
  assert.equal(
    countOccurrences(productionSql, productionTransactionTimeout),
    2,
  );
  assert.equal(countOccurrences(productionSql, fixtureTransactionTimeout), 0);

  const executionSql = productionSql.replaceAll(
    productionTransactionTimeout,
    fixtureTransactionTimeout,
  );
  assert.equal(countOccurrences(executionSql, productionTransactionTimeout), 0);
  assert.equal(countOccurrences(executionSql, fixtureTransactionTimeout), 2);
  return executionSql;
}

export function assertStage2PooledTransactionShape(sql: string): void {
  const statements = splitMigrationStatements(sql);
  for (const statement of statements) {
    const executableStatement = statement.replace(
      /^(?:--[^\n]*(?:\n|$)\s*)+/u,
      "",
    );
    assert.doesNotMatch(executableStatement, /^SET(?!\s+LOCAL\b)/u);
    assert.doesNotMatch(executableStatement, /^RESET\b/u);
  }
  assert.doesNotMatch(
    sql,
    /vm0\.agent_run_metadata_backfill_no_progress_timeout/u,
  );
  assert.equal(countOccurrences(sql, productionBackfillCall), 1);
  assert.equal(
    countOccurrences(
      sql,
      "v_minimum_server_version_num CONSTANT integer := 170000;",
    ),
    1,
  );
  assert.equal(countOccurrences(sql, productionTransactionTimeout), 2);
  assert.equal(
    countOccurrences(
      sql,
      'array_agg("definition" ORDER BY "definition" COLLATE "C")',
    ),
    8,
  );
  assert.doesNotMatch(sql, /array_agg\("definition" ORDER BY "definition"\)/u);

  const preflight = statements.find((statement) => {
    return statement.includes(
      "Stage 2 preflight requires PostgreSQL server_version_num",
    );
  });
  assert.ok(preflight);
  const serverVersionCheck = preflight.indexOf(
    "SELECT current_setting('server_version_num')::integer",
  );
  const ledgerCheck = preflight.indexOf(
    'FROM "drizzle"."__drizzle_migrations"',
  );
  assert.ok(serverVersionCheck >= 0);
  assert.ok(ledgerCheck > serverVersionCheck);

  const procedure = statements.find((statement) => {
    return statement.startsWith(
      'CREATE OR REPLACE PROCEDURE "backfill_agent_run_metadata_stage2"(',
    );
  });
  assert.ok(procedure);
  const firstCandidate = procedure.indexOf('WITH "batch" AS MATERIALIZED');
  assert.ok(firstCandidate > 0);
  const beforeFirstCandidate = procedure.slice(0, firstCandidate);
  const initialLockTimeout = beforeFirstCandidate.lastIndexOf(
    "SET LOCAL lock_timeout = '1s';",
  );
  const initialTransactionTimeout = beforeFirstCandidate.lastIndexOf(
    productionTransactionTimeout,
  );
  assert.ok(initialLockTimeout >= 0);
  assert.ok(initialTransactionTimeout > initialLockTimeout);
  assert.doesNotMatch(procedure, /SET LOCAL statement_timeout\b/u);

  assert.equal((procedure.match(/\bCOMMIT;/gu) ?? []).length, 1);
  assert.equal(
    (
      procedure.match(
        /COMMIT;\s*SET LOCAL lock_timeout = '1s';\s*SET LOCAL transaction_timeout = '5min';/gu,
      ) ?? []
    ).length,
    1,
  );

  const isBegin = (statement: string): boolean => {
    return /(?:^|\n)BEGIN(?: TRANSACTION[^;]*)?;\s*$/u.test(statement);
  };
  const beginIndexes = statements
    .map((statement, index) => {
      return isBegin(statement) ? index : -1;
    })
    .filter((index) => {
      return index >= 0;
    });
  assert.ok(beginIndexes.length > 0);
  for (const beginIndex of beginIndexes) {
    assert.equal(statements[beginIndex + 1], "SET LOCAL lock_timeout = '1s';");
    assert.match(
      statements[beginIndex + 2] ?? "",
      /^SET LOCAL statement_timeout = '[^']+';$/u,
    );
  }

  let inExplicitTransaction = false;
  const concurrentBuilds: string[] = [];
  for (const statement of statements) {
    if (isBegin(statement)) {
      assert.equal(inExplicitTransaction, false);
      inExplicitTransaction = true;
      continue;
    }
    if (statement === "COMMIT;") {
      assert.equal(inExplicitTransaction, true);
      inExplicitTransaction = false;
      continue;
    }
    if (/^(?:CREATE|DROP) INDEX CONCURRENTLY\b/u.test(statement)) {
      assert.equal(inExplicitTransaction, false);
    }
    if (statement.startsWith("CREATE INDEX CONCURRENTLY")) {
      concurrentBuilds.push(statement);
    }
    if (statement === productionBackfillCall) {
      assert.equal(inExplicitTransaction, false);
    }
  }
  assert.equal(inExplicitTransaction, false);
  assert.deepEqual(
    concurrentBuilds.map((statement) => {
      return statement.match(/"(idx_agent_runs_[^"]+)"/u)?.[1];
    }),
    [
      "idx_agent_runs_chat_thread_id",
      "idx_agent_runs_workflow_automation",
      "idx_agent_runs_goal",
    ],
  );
}

export function assertProductionExceptionConstants(
  sql: string,
  expectedSections: number,
): void {
  assert.equal(
    countOccurrences(sql, productionAgentOnlyDigest),
    expectedSections,
  );
  assert.equal(
    countOccurrences(sql, productionCallbackDigest),
    expectedSections,
  );

  const acceptedArrays = [
    ...sql.matchAll(
      /v_accepted_agent_only_ids uuid\[\] := ARRAY\[([\s\S]*?)\n\s*\];/gu,
    ),
  ];
  assert.equal(acceptedArrays.length, expectedSections);
  for (const acceptedArray of acceptedArrays) {
    const ids = [
      ...(acceptedArray[1] ?? "").matchAll(
        /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'::uuid/gu,
      ),
    ].map((match) => {
      return match[1];
    });
    assert.deepEqual(ids, acceptedAgentOnlyIds);
  }
  for (const id of acceptedAgentOnlyIds) {
    assert.equal(countOccurrences(sql, `'${id}'::uuid`), expectedSections);
  }
}

function noticeVariables(sql: string, noticePattern: RegExp): string[] {
  const notice = sql.match(noticePattern);
  assert.ok(notice);
  return [...(notice[1] ?? "").matchAll(/\bv_[a-z0-9_]+\b/gu)].map((match) => {
    return match[0];
  });
}

export function assertStage2NoticeVariableBindings(sql: string): void {
  assert.deepEqual(
    noticeVariables(
      sql,
      /RAISE NOTICE\s+'Stage 2 agent-run metadata preflight:[^']*',([\s\S]*?);/u,
    ),
    [
      "v_ledger_timestamp",
      "v_agent_run_count",
      "v_zero_run_count",
      "v_paired_count",
      "v_zero_only_count",
      "v_invalid_source_count",
      "v_agent_only_count",
      "v_agent_only_digest",
      "v_callback_count",
      "v_callback_run_count",
      "v_callback_digest",
      "v_inbound_fk_count",
      "v_reviewed_non_fk_count",
      "v_fk_dependency_match_count",
      "v_non_fk_dependency_match_count",
      "v_bridge_trigger_count",
    ],
  );
  assert.deepEqual(
    noticeVariables(
      sql,
      /RAISE NOTICE\s+'Stage 2 agent-run metadata validation:[^']*',([\s\S]*?);/u,
    ),
    [
      "v_agent_run_count",
      "v_zero_run_count",
      "v_paired_count",
      "v_zero_only_count",
      "v_invalid_source_count",
      "v_agent_only_count",
      "v_agent_only_digest",
      "v_callback_count",
      "v_callback_run_count",
      "v_callback_digest",
      "v_metadata_mismatch_count",
      "v_inbound_fk_count",
      "v_reviewed_non_fk_count",
      "v_fk_dependency_match_count",
      "v_non_fk_dependency_match_count",
      "v_ready_valid_index_count",
      "v_recovery_index_count",
      "v_validated_constraint_count",
      "v_bridge_trigger_count",
    ],
  );
}

export function createCallbackFixtureExecutionSql(
  productionSql: string,
  fixtureDigest: string,
  expectedSections: number,
): string {
  assertProductionExceptionConstants(productionSql, expectedSections);
  assert.equal(countOccurrences(productionSql, fixtureDigest), 0);

  const executionSql = productionSql.replaceAll(
    productionCallbackDigest,
    fixtureDigest,
  );
  assert.equal(countOccurrences(executionSql, productionCallbackDigest), 0);
  assert.equal(countOccurrences(executionSql, fixtureDigest), expectedSections);
  assert.equal(
    countOccurrences(executionSql, productionAgentOnlyDigest),
    expectedSections,
  );
  for (const id of acceptedAgentOnlyIds) {
    assert.equal(
      countOccurrences(executionSql, `'${id}'::uuid`),
      expectedSections,
    );
  }
  return executionSql;
}
