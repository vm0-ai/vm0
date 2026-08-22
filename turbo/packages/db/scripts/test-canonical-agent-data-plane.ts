import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");
const previousMigration = "0965_contract_legacy_built_in_model_key_relation";
const migration = "0966_canonical_agents_data_plane";
const testDatabase = "migration_canonical_agents_data_plane";
const fixedAgentId = "00000000-0000-4000-8000-000000096600";
const composeOnlyId = "00000000-0000-4000-8000-0000000966ff";

const siblingColumns = [
  "agent_sessions.agent_id",
  "agentphone_user_agent_preferences.selected_agent_id",
  "chat_event_search_messages.agent_id",
  "chat_thread_events.agent_id",
  "chat_threads.agent_id",
  "feishu_org_installations.default_agent_id",
  "feishu_user_agent_preferences.selected_agent_id",
  "github_installations.default_agent_id",
  "slack_user_agent_preferences.selected_agent_id",
  "teams_user_agent_preferences.selected_agent_id",
  "telegram_installations.default_agent_id",
  "telegram_user_agent_preferences.selected_agent_id",
] as const;

const replacementIndexes = [
  "chat_event_search_messages_user_org_agent_id_created_idx",
  "idx_agent_sessions_user_agent",
  "idx_chat_threads_user_agent_last_message",
  "idx_chat_threads_user_agent_pinned",
  "idx_chat_threads_user_agent_updated",
] as const;

interface CatalogBaseline {
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
  readonly indexes: readonly string[];
  readonly relations: readonly string[];
}

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

function splitMigrationStatements(migrationSql: string): readonly string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

async function executeStatements(args: {
  readonly client: Client;
  readonly endExclusive?: number;
  readonly replacements?: ReadonlyMap<number, string>;
  readonly statements: readonly string[];
}): Promise<void> {
  const endExclusive = args.endExclusive ?? args.statements.length;
  for (let index = 0; index < endExclusive; index += 1) {
    await args.client.query(
      args.replacements?.get(index) ?? args.statements[index]!,
    );
  }
}

function assertDatabaseError(
  error: unknown,
  args: { readonly code?: string; readonly messageIncludes?: string },
): void {
  assert.ok(error instanceof Error);
  if (args.code !== undefined) {
    assert.equal((error as Error & { readonly code?: string }).code, args.code);
  }
  if (args.messageIncludes !== undefined) {
    assert.ok(
      error.message.includes(args.messageIncludes),
      `expected database error to include ${args.messageIncludes}, received ${error.message}`,
    );
  }
}

function validateMigrationSql(migrationSql: string): void {
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(migrationSql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
  assert.doesNotMatch(migrationSql, /\bRENAME\s+(?:TABLE|COLUMN)\b/iu);
  assert.doesNotMatch(
    migrationSql,
    /CREATE\s+TRIGGER[\s\S]{0,300}\sON\s+"agents"/iu,
  );
  assert.equal(migrationSql.match(/LIMIT 500/gu)?.length, 2);
  assert.equal(migrationSql.match(/FOR UPDATE[^\n]*SKIP LOCKED/gu)?.length, 2);
  assert.equal(
    migrationSql.match(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /gmu)?.length,
    replacementIndexes.length,
  );
  assert.equal(
    migrationSql.match(/^CALL "backfill_agent_references_0966"/gmu)?.length,
    siblingColumns.length,
  );
  assert.equal(
    migrationSql.match(/^CALL "ensure_agent_foreign_key_0966"/gmu)?.length,
    18,
  );
  assert.equal(
    migrationSql.match(/^CALL "ensure_agent_reference_check_0966"/gmu)?.length,
    siblingColumns.length,
  );
  assert.equal(
    migrationSql.match(/^ALTER TABLE .* VALIDATE CONSTRAINT /gmu)?.length,
    30,
  );
  assert.match(migrationSql, /SET lock_timeout = '1s'/u);
  assert.match(migrationSql, /SET LOCAL lock_timeout = '1s'/u);
  assert.match(migrationSql, /transaction_timeout = '5min'/u);
  assert.match(migrationSql, /p_no_progress_timeout > interval '30 seconds'/u);
  assert.match(
    migrationSql,
    /created_at"[\s\S]*greatest\("compose"\."updated_at", "zero_agent"\."updated_at"\)/u,
  );
}

async function collectCatalogBaseline(
  client: Client,
): Promise<CatalogBaseline> {
  const relations = await client.query<{ value: string }>(`
    SELECT "namespace"."nspname" || '.' || "relation"."relname" AS "value"
    FROM "pg_class" AS "relation"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "relation"."relkind" IN ('r', 'p', 'v', 'm', 'S')
    ORDER BY "value"
  `);
  const columns = await client.query<{ value: string }>(`
    SELECT concat_ws('|', "table_name", "column_name", "data_type",
      "is_nullable", coalesce("column_default", '')) AS "value"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
    ORDER BY "table_name", "ordinal_position"
  `);
  const constraints = await client.query<{ value: string }>(`
    SELECT concat_ws('|', "constraint"."conrelid"::regclass::text,
      "constraint"."conname", "constraint"."contype",
      pg_get_constraintdef("constraint"."oid")) AS "value"
    FROM "pg_constraint" AS "constraint"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "constraint"."connamespace"
    WHERE "namespace"."nspname" = 'public'
    ORDER BY "value"
  `);
  const indexes = await client.query<{ value: string }>(`
    SELECT concat_ws('|', "tablename", "indexname", "indexdef") AS "value"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
    ORDER BY "value"
  `);
  return {
    relations: relations.rows.map(({ value }) => {
      return value;
    }),
    columns: columns.rows.map(({ value }) => {
      return value;
    }),
    constraints: constraints.rows.map(({ value }) => {
      return value;
    }),
    indexes: indexes.rows.map(({ value }) => {
      return value;
    }),
  };
}

function assertBaselineRetained(
  baseline: CatalogBaseline,
  observed: CatalogBaseline,
): void {
  for (const kind of [
    "relations",
    "columns",
    "constraints",
    "indexes",
  ] as const) {
    const observedEntries = new Set(observed[kind]);
    for (const entry of baseline[kind]) {
      assert.ok(observedEntries.has(entry), `missing legacy ${kind}: ${entry}`);
    }
  }
}

async function seedPreviousSchema(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" (
        "id", "user_id", "name", "org_id", "created_at", "updated_at"
      ) VALUES (
        $1, 'canonical-owner', 'canonical-fixed', 'canonical-org',
        timestamp '2026-01-01 00:00:00', timestamp '2026-01-03 00:00:00'
      )
    `,
    [fixedAgentId],
  );
  await client.query(`
    INSERT INTO "agent_composes" (
      "id", "user_id", "name", "org_id", "created_at", "updated_at"
    )
    SELECT
      md5('canonical-agent-' || "position")::uuid,
      'canonical-owner',
      'canonical-' || lpad("position"::text, 4, '0'),
      'canonical-org',
      timestamp '2026-02-01 00:00:00' + "position" * interval '1 second',
      timestamp '2026-02-02 00:00:00' + "position" * interval '1 second'
    FROM generate_series(1, 501) AS "fixture"("position")
  `);
  await client.query(
    `
      INSERT INTO "agent_composes" (
        "id", "user_id", "name", "org_id", "created_at", "updated_at"
      ) VALUES (
        $1, 'compose-only-owner', 'compose-only-artifact',
        'compose-only-org', timestamp '2025-01-01 00:00:00',
        timestamp '2025-01-02 00:00:00'
      )
    `,
    [composeOnlyId],
  );

  await client.query(
    `
      INSERT INTO "zero_agents" (
        "id", "org_id", "owner", "name", "visibility", "display_name",
        "description", "sound", "avatar_url", "selected_model",
        "prefer_personal_provider", "created_at", "updated_at"
      ) VALUES (
        $1, 'canonical-org', 'canonical-owner', 'canonical-fixed', 'private',
        'Canonical Fixed', 'canonical description', 'canonical-sound',
        'https://example.test/canonical.png', 'canonical-model', true,
        timestamp '2026-01-02 00:00:00', timestamp '2026-01-04 00:00:00'
      )
    `,
    [fixedAgentId],
  );
  await client.query(
    `
    INSERT INTO "zero_agents" (
      "id", "org_id", "owner", "name", "created_at", "updated_at"
    )
    SELECT
      "compose"."id", "compose"."org_id", "compose"."user_id",
      "compose"."name", "compose"."created_at" + interval '1 hour',
      "compose"."updated_at" + interval '1 hour'
    FROM "agent_composes" AS "compose"
    WHERE "compose"."id" <> $1
      AND "compose"."id" <> $2
  `,
    [fixedAgentId, composeOnlyId],
  );

  await client.query(`
    INSERT INTO "agent_sessions" (
      "id", "user_id", "org_id", "agent_compose_id"
    )
    SELECT
      md5('canonical-session-' || "compose"."id"::text)::uuid,
      "compose"."user_id", "compose"."org_id", "compose"."id"
    FROM "agent_composes" AS "compose"
    INNER JOIN "zero_agents" AS "zero_agent"
      ON "zero_agent"."id" = "compose"."id"
  `);
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      )
      SELECT
        md5('compose-only-session-' || "position")::uuid,
        'compose-only-owner', 'compose-only-org', $1
      FROM generate_series(1, 22) AS "fixture"("position")
    `,
    [composeOnlyId],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" ("id", "user_id", "agent_compose_id")
      VALUES (
        '00000000-0000-4000-8000-0000000966aa',
        'compose-only-owner', $1
      )
    `,
    [composeOnlyId],
  );
  await client.query(
    `
      INSERT INTO "chat_event_search_messages" (
        "chat_thread_id", "seq_id", "user_id", "org_id",
        "agent_compose_id", "role", "created_at", "text", "text_bigram"
      ) VALUES
        (
          '00000000-0000-4000-8000-0000000966aa', 1,
          'compose-only-owner', 'compose-only-org', $1, 'user',
          timestamp '2026-08-22 00:00:00', 'compose only one',
          'compose only one'
        ),
        (
          '00000000-0000-4000-8000-0000000966aa', 2,
          'compose-only-owner', 'compose-only-org', $1, 'assistant',
          timestamp '2026-08-22 00:00:01', 'compose only two',
          'compose only two'
        )
    `,
    [composeOnlyId],
  );
}

async function assertCatalogLockRetryBoundary(args: {
  readonly blocker: Client;
  readonly runner: Client;
  readonly statements: readonly string[];
}): Promise<void> {
  const firstSiblingColumn = args.statements.findIndex((statement) => {
    return statement.startsWith(
      'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "agent_id"',
    );
  });
  assert.ok(firstSiblingColumn > 0);
  await args.blocker.query("BEGIN");
  await args.blocker.query(`SELECT 1 FROM "agent_sessions" LIMIT 1`);
  try {
    await assert.rejects(
      executeStatements({
        client: args.runner,
        statements: args.statements,
        endExclusive: firstSiblingColumn + 1,
      }),
      (error: unknown) => {
        assertDatabaseError(error, { code: "55P03" });
        return true;
      },
    );
  } finally {
    await args.blocker.query("ROLLBACK");
  }

  const partial = await args.runner.query<{
    agentIdColumn: string | null;
    agentTable: string | null;
    bridgeCount: number;
  }>(`
    SELECT
      to_regclass('public.agents')::text AS "agentTable",
      (
        SELECT "column_name"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'agent_sessions'
          AND "column_name" = 'agent_id'
      ) AS "agentIdColumn",
      (
        SELECT count(*)::integer
        FROM "pg_trigger"
        WHERE NOT "tgisinternal"
          AND "tgname" IN (
            'bridge_agent_composes_to_agents_0966',
            'bridge_zero_agents_to_agents_0966'
          )
      ) AS "bridgeCount"
  `);
  assert.deepEqual(partial.rows, [
    { agentTable: "agents", agentIdColumn: null, bridgeCount: 2 },
  ]);
}

async function assertAgentBackfillContention(args: {
  readonly blocker: Client;
  readonly runner: Client;
  readonly statements: readonly string[];
}): Promise<number> {
  const callIndex = args.statements.findIndex((statement) => {
    return statement === `CALL "backfill_agents_0966"(interval '30 seconds');`;
  });
  assert.ok(callIndex > 0);
  await executeStatements({
    client: args.runner,
    statements: args.statements,
    endExclusive: callIndex,
  });
  const locked = await args.runner.query<{ id: string }>(`
    SELECT "id"::text AS "id" FROM "zero_agents" ORDER BY "id" LIMIT 1
  `);
  assert.equal(locked.rows.length, 1);
  await args.blocker.query("BEGIN");
  await args.blocker.query(
    `SELECT 1 FROM "zero_agents" WHERE "id" = $1 FOR UPDATE`,
    [locked.rows[0]!.id],
  );
  try {
    await assert.rejects(
      args.runner.query(
        `CALL "backfill_agents_0966"(interval '100 milliseconds')`,
      ),
      (error: unknown) => {
        assertDatabaseError(error, {
          messageIncludes: "Canonical Agent backfill made no progress",
        });
        return true;
      },
    );
  } finally {
    await args.blocker.query("ROLLBACK");
  }
  const partial = await args.runner.query<{ count: number }>(`
    SELECT count(*)::integer AS "count" FROM "agents"
  `);
  assert.deepEqual(partial.rows, [{ count: 501 }]);
  return callIndex;
}

async function assertReferenceBackfillContention(args: {
  readonly blocker: Client;
  readonly runner: Client;
  readonly statements: readonly string[];
}): Promise<void> {
  const callIndex = args.statements.findIndex((statement) => {
    return statement.startsWith(
      `CALL "backfill_agent_references_0966"('public.agent_sessions'`,
    );
  });
  assert.ok(callIndex > 0);

  await executeStatements({
    client: args.runner,
    statements: args.statements,
    endExclusive: callIndex,
  });

  const locked = await args.runner.query<{ id: string }>(`
    SELECT "session"."id"::text AS "id"
    FROM "agent_sessions" AS "session"
    INNER JOIN "zero_agents" AS "zero_agent"
      ON "zero_agent"."id" = "session"."agent_compose_id"
    ORDER BY "session"."id"
    LIMIT 1
  `);
  assert.equal(locked.rows.length, 1);
  await args.blocker.query("BEGIN");
  await args.blocker.query(
    `SELECT 1 FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`,
    [locked.rows[0]!.id],
  );
  try {
    await assert.rejects(
      args.runner.query(
        `CALL "backfill_agent_references_0966"(
          'public.agent_sessions', ARRAY['id']::name[],
          'agent_compose_id', 'agent_id', interval '100 milliseconds'
        )`,
      ),
      (error: unknown) => {
        assertDatabaseError(error, {
          messageIncludes:
            "Canonical Agent reference backfill made no progress",
        });
        return true;
      },
    );
  } finally {
    await args.blocker.query("ROLLBACK");
  }

  const partial = await args.runner.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "agent_sessions"
    WHERE "agent_id" IS NOT NULL
  `);
  assert.deepEqual(partial.rows, [{ count: 501 }]);
}

async function validateFinalCatalog(
  client: Client,
  baseline: CatalogBaseline,
): Promise<void> {
  assertBaselineRetained(baseline, await collectCatalogBaseline(client));

  const columns = await client.query<{ value: string }>(
    `
    SELECT "table_name" || '.' || "column_name" AS "value"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND ("table_name" || '.' || "column_name") = ANY($1::text[])
    ORDER BY "value"
  `,
    [[...siblingColumns]],
  );
  assert.deepEqual(
    columns.rows.map(({ value }) => {
      return value;
    }),
    [...siblingColumns],
  );

  const agentColumns = await client.query<{ columnName: string }>(`
    SELECT "column_name" AS "columnName"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public' AND "table_name" = 'agents'
    ORDER BY "ordinal_position"
  `);
  assert.deepEqual(
    agentColumns.rows.map(({ columnName }) => {
      return columnName;
    }),
    [
      "id",
      "org_id",
      "owner",
      "name",
      "visibility",
      "display_name",
      "description",
      "sound",
      "avatar_url",
      "model_provider_id",
      "selected_model",
      "prefer_personal_provider",
      "created_at",
      "updated_at",
    ],
  );

  const constraints = await client.query<{
    checkCount: number;
    foreignKeyCount: number;
  }>(`
    SELECT
      count(*) FILTER (
        WHERE "contype" = 'f'
          AND "confrelid" = 'public.agents'::regclass
          AND "convalidated"
      )::integer AS "foreignKeyCount",
      count(*) FILTER (
        WHERE "contype" = 'c'
          AND "convalidated"
          AND "conname" LIKE '%agent_reference_match'
      )::integer AS "checkCount"
    FROM "pg_constraint"
  `);
  assert.deepEqual(constraints.rows, [{ foreignKeyCount: 18, checkCount: 12 }]);

  const triggers = await client.query<{
    bridgeCount: number;
    targetCount: number;
  }>(`
    SELECT
      count(*) FILTER (
        WHERE NOT "tgisinternal" AND "tgname" LIKE 'bridge_%_0966'
      )::integer AS "bridgeCount",
      count(*) FILTER (
        WHERE NOT "tgisinternal"
          AND "tgrelid" = 'public.agents'::regclass
      )::integer AS "targetCount"
    FROM "pg_trigger"
  `);
  assert.deepEqual(triggers.rows, [{ bridgeCount: 14, targetCount: 0 }]);

  const procedures = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "pg_proc" AS "procedure"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "procedure"."pronamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "procedure"."proname" = ANY(ARRAY[
        'backfill_agents_0966', 'backfill_agent_references_0966',
        'ensure_agent_foreign_key_0966',
        'ensure_agent_reference_check_0966'
      ])
  `);
  assert.deepEqual(procedures.rows, [{ count: 0 }]);

  const indexes = await client.query<{
    indexName: string;
    ready: boolean;
    valid: boolean;
  }>(
    `
    SELECT "relation"."relname" AS "indexName",
      "index"."indisready" AS "ready", "index"."indisvalid" AS "valid"
    FROM "pg_index" AS "index"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "index"."indexrelid"
    INNER JOIN "pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "relation"."relname" = ANY($1::text[])
    ORDER BY "indexName"
  `,
    [[...replacementIndexes]],
  );
  assert.deepEqual(
    indexes.rows,
    replacementIndexes.map((indexName) => {
      return { indexName, ready: true, valid: true };
    }),
  );
}

async function validateBackfillAndComposeOnlyClosure(
  client: Client,
): Promise<void> {
  const parity = await client.query<{
    composeOnlyAgentCount: number;
    composeOnlySearchNullCount: number;
    composeOnlySessionNullCount: number;
    composeOnlyThreadNullCount: number;
    fieldMismatchCount: number;
    matchedCount: number;
    targetCount: number;
  }>(
    `
    SELECT
      (
        SELECT count(*)::integer
        FROM "agent_composes" AS "compose"
        INNER JOIN "zero_agents" AS "zero_agent"
          ON "zero_agent"."id" = "compose"."id"
      ) AS "matchedCount",
      (SELECT count(*)::integer FROM "agents") AS "targetCount",
      (
        SELECT count(*)::integer
        FROM "agent_composes" AS "compose"
        INNER JOIN "zero_agents" AS "zero_agent"
          ON "zero_agent"."id" = "compose"."id"
        INNER JOIN "agents" AS "agent" ON "agent"."id" = "compose"."id"
        WHERE ROW(
          "agent"."org_id", "agent"."owner", "agent"."name",
          "agent"."visibility", "agent"."display_name",
          "agent"."description", "agent"."sound", "agent"."avatar_url",
          "agent"."model_provider_id", "agent"."selected_model",
          "agent"."prefer_personal_provider", "agent"."created_at",
          "agent"."updated_at"
        ) IS DISTINCT FROM ROW(
          "zero_agent"."org_id", "zero_agent"."owner", "zero_agent"."name",
          "zero_agent"."visibility", "zero_agent"."display_name",
          "zero_agent"."description", "zero_agent"."sound",
          "zero_agent"."avatar_url", "zero_agent"."model_provider_id",
          "zero_agent"."selected_model",
          "zero_agent"."prefer_personal_provider", "compose"."created_at",
          greatest("compose"."updated_at", "zero_agent"."updated_at")
        )
      ) AS "fieldMismatchCount",
      (
        SELECT count(*)::integer FROM "agents" WHERE "id" = $1
      ) AS "composeOnlyAgentCount",
      (
        SELECT count(*)::integer FROM "agent_sessions"
        WHERE "agent_compose_id" = $1 AND "agent_id" IS NULL
      ) AS "composeOnlySessionNullCount",
      (
        SELECT count(*)::integer FROM "chat_threads"
        WHERE "agent_compose_id" = $1 AND "agent_id" IS NULL
      ) AS "composeOnlyThreadNullCount",
      (
        SELECT count(*)::integer FROM "chat_event_search_messages"
        WHERE "agent_compose_id" = $1 AND "agent_id" IS NULL
      ) AS "composeOnlySearchNullCount"
  `,
    [composeOnlyId],
  );
  assert.deepEqual(parity.rows, [
    {
      matchedCount: 502,
      targetCount: 502,
      fieldMismatchCount: 0,
      composeOnlyAgentCount: 0,
      composeOnlySessionNullCount: 22,
      composeOnlyThreadNullCount: 1,
      composeOnlySearchNullCount: 2,
    },
  ]);
}

async function validateBridgeBehavior(client: Client): Promise<void> {
  const transientId = "00000000-0000-4000-8000-0000000966ee";
  await client.query(
    `
      INSERT INTO "agent_composes" (
        "id", "user_id", "name", "org_id", "created_at", "updated_at"
      ) VALUES (
        $1, 'transient-owner', 'transient-agent', 'transient-org',
        timestamp '2026-03-01 00:00:00', timestamp '2026-03-02 00:00:00'
      )
    `,
    [transientId],
  );
  assert.deepEqual(
    (
      await client.query<{ count: number }>(
        `SELECT count(*)::integer AS "count" FROM "agents" WHERE "id" = $1`,
        [transientId],
      )
    ).rows,
    [{ count: 0 }],
  );

  await client.query(
    `
      INSERT INTO "zero_agents" (
        "id", "org_id", "owner", "name", "display_name", "updated_at"
      ) VALUES (
        $1, 'transient-org', 'transient-owner', 'transient-agent',
        'Transient Agent', timestamp '2026-03-03 00:00:00'
      )
    `,
    [transientId],
  );
  const created = await client.query<{
    createdAt: string;
    displayName: string | null;
    updatedAt: string;
  }>(
    `
    SELECT to_char("created_at", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
      to_char("updated_at", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt",
      "display_name" AS "displayName"
    FROM "agents" WHERE "id" = $1
  `,
    [transientId],
  );
  assert.deepEqual(created.rows, [
    {
      createdAt: "2026-03-01 00:00:00",
      updatedAt: "2026-03-03 00:00:00",
      displayName: "Transient Agent",
    },
  ]);

  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE "zero_agents" SET "description" = 'rolled back' WHERE "id" = $1`,
      [transientId],
    );
    assert.deepEqual(
      (
        await client.query<{ description: string | null }>(
          `
          SELECT "description" FROM "agents" WHERE "id" = $1
        `,
          [transientId],
        )
      ).rows,
      [{ description: "rolled back" }],
    );
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  assert.deepEqual(
    (
      await client.query<{ description: string | null }>(
        `
        SELECT "description" FROM "agents" WHERE "id" = $1
      `,
        [transientId],
      )
    ).rows,
    [{ description: null }],
  );

  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE "agents" SET "display_name" = 'forbidden reverse write' WHERE "id" = $1`,
      [transientId],
    );
    assert.deepEqual(
      (
        await client.query<{ displayName: string | null }>(
          `
          SELECT "display_name" AS "displayName"
          FROM "zero_agents" WHERE "id" = $1
        `,
          [transientId],
        )
      ).rows,
      [{ displayName: "Transient Agent" }],
    );
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const matchedReferenceId = "00000000-0000-4000-8000-0000000966e1";
  const composeOnlyReferenceId = "00000000-0000-4000-8000-0000000966e2";
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      ) VALUES
        ($1, 'transient-owner', 'transient-org', $3),
        ($2, 'compose-only-owner', 'compose-only-org', $4)
    `,
    [matchedReferenceId, composeOnlyReferenceId, transientId, composeOnlyId],
  );
  const references = await client.query<{
    agentComposeId: string;
    agentId: string | null;
    id: string;
  }>(
    `
    SELECT "id"::text AS "id", "agent_compose_id"::text AS "agentComposeId",
      "agent_id"::text AS "agentId"
    FROM "agent_sessions"
    WHERE "id" = ANY($1::uuid[])
    ORDER BY "id"
  `,
    [[matchedReferenceId, composeOnlyReferenceId]],
  );
  assert.deepEqual(references.rows, [
    {
      id: matchedReferenceId,
      agentComposeId: transientId,
      agentId: transientId,
    },
    {
      id: composeOnlyReferenceId,
      agentComposeId: composeOnlyId,
      agentId: null,
    },
  ]);

  await client.query(
    `DELETE FROM "agent_sessions" WHERE "id" = ANY($1::uuid[])`,
    [[matchedReferenceId, composeOnlyReferenceId]],
  );
  await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    transientId,
  ]);
  assert.deepEqual(
    (
      await client.query<{ count: number }>(
        `SELECT count(*)::integer AS "count" FROM "agents" WHERE "id" = $1`,
        [transientId],
      )
    ).rows,
    [{ count: 0 }],
  );
  assert.deepEqual(
    (
      await client.query<{ count: number }>(
        `SELECT count(*)::integer AS "count" FROM "zero_agents" WHERE "id" = $1`,
        [transientId],
      )
    ).rows,
    [{ count: 0 }],
  );
}

async function waitForBackendLock(client: Client, backendPid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await client.query<{ waitEventType: string | null }>(
      `
        SELECT "wait_event_type" AS "waitEventType"
        FROM "pg_stat_activity"
        WHERE "pid" = $1
      `,
      [backendPid],
    );
    if (activity.rows[0]?.waitEventType === "Lock") return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail("concurrent legacy bridge writer did not wait on the target row");
}

async function validateConcurrentBridgeBehavior(
  observer: Client,
  testUrl: string,
): Promise<void> {
  const composeWriter = await connect(testUrl);
  const productWriter = await connect(testUrl);
  let productUpdate: Promise<unknown> | undefined;
  try {
    const backend = await productWriter.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    const backendPid = backend.rows[0]!.pid;
    await composeWriter.query("BEGIN");
    await productWriter.query("BEGIN");
    await composeWriter.query(
      `
        UPDATE "agent_composes"
        SET "updated_at" = timestamp '2026-04-01 00:00:00'
        WHERE "id" = $1
      `,
      [fixedAgentId],
    );
    productUpdate = productWriter.query(
      `
        UPDATE "zero_agents"
        SET "display_name" = 'Concurrent Agent',
          "updated_at" = timestamp '2026-04-02 00:00:00'
        WHERE "id" = $1
      `,
      [fixedAgentId],
    );
    await waitForBackendLock(observer, backendPid);
    await composeWriter.query("COMMIT");
    await productUpdate;
    productUpdate = undefined;
    await productWriter.query("COMMIT");
  } finally {
    await composeWriter.query("ROLLBACK").catch(() => {});
    await productUpdate?.catch(() => {});
    await productWriter.query("ROLLBACK").catch(() => {});
    await composeWriter.end();
    await productWriter.end();
  }

  const canonical = await observer.query<{
    displayName: string | null;
    updatedAt: string;
  }>(
    `
      SELECT "display_name" AS "displayName",
        to_char("updated_at", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
      FROM "agents" WHERE "id" = $1
    `,
    [fixedAgentId],
  );
  assert.deepEqual(canonical.rows, [
    { displayName: "Concurrent Agent", updatedAt: "2026-04-02 00:00:00" },
  ]);
}

async function validateInvalidIndexRecovery(args: {
  readonly client: Client;
  readonly statements: readonly string[];
}): Promise<void> {
  await args.client.query(`
    UPDATE "pg_index"
    SET "indisvalid" = false
    WHERE "indexrelid" = 'public.idx_agent_sessions_user_agent'::regclass
  `);
  await executeStatements({
    client: args.client,
    statements: args.statements,
  });
  const recovered = await args.client.query<{
    ready: boolean;
    recoveryArtifact: string | null;
    valid: boolean;
  }>(`
    SELECT
      "index"."indisready" AS "ready",
      "index"."indisvalid" AS "valid",
      to_regclass('public.idx_agent_sessions_user_agent_0966_invalid')::text
        AS "recoveryArtifact"
    FROM "pg_index" AS "index"
    WHERE "index"."indexrelid" =
      'public.idx_agent_sessions_user_agent'::regclass
  `);
  assert.deepEqual(recovered.rows, [
    { ready: true, valid: true, recoveryArtifact: null },
  ]);
}

export async function validateCanonicalAgentDataPlaneMigration(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = databaseUrlFor(databaseUrl, "postgres");
  const testUrl = databaseUrlFor(databaseUrl, testDatabase);
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${migration}.sql`),
    "utf8",
  );
  validateMigrationSql(migrationSql);
  const statements = splitMigrationStatements(migrationSql);

  const admin = await connect(adminUrl);
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
  await admin.end();

  const runner = await connect(testUrl);
  const blocker = await connect(testUrl);
  try {
    await applyMigrationsFromDirectoryUpToTag(
      runner,
      migrationsDirectory,
      previousMigration,
    );
    await seedPreviousSchema(runner);
    const baseline = await collectCatalogBaseline(runner);

    await assertCatalogLockRetryBoundary({ blocker, runner, statements });
    await assertAgentBackfillContention({ blocker, runner, statements });
    await assertReferenceBackfillContention({ blocker, runner, statements });

    await executeStatements({ client: runner, statements });
    await validateFinalCatalog(runner, baseline);
    await validateBackfillAndComposeOnlyClosure(runner);
    await validateBridgeBehavior(runner);
    await validateConcurrentBridgeBehavior(runner, testUrl);
    await validateInvalidIndexRecovery({ client: runner, statements });
    await validateFinalCatalog(runner, baseline);
    await validateBackfillAndComposeOnlyClosure(runner);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await runner.query("ROLLBACK").catch(() => {});
    await blocker.end();
    await runner.end();
    const cleanup = await connect(adminUrl);
    await cleanup.query(
      `DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`,
    );
    await cleanup.end();
  }

  console.log("canonical Agent data-plane migration passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateCanonicalAgentDataPlaneMigration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
