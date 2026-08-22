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
const correctionMigration = "0968_repair_canonical_agent_bridge_race";
const testDatabase = "migration_canonical_agents_data_plane";
const fixedAgentId = "00000000-0000-4000-8000-000000096600";
const composeOnlyId = "00000000-0000-4000-8000-0000000966ff";
const fixedChatThreadEventId = "00000000-0000-4000-8000-0000000966d1";
const composeOnlyChatThreadEventId = "00000000-0000-4000-8000-0000000966df";
const deletedSnapshotAgentId = "00000000-0000-4000-8000-0000000966c0";
const deletedSnapshotThreadId = "00000000-0000-4000-8000-0000000966c1";
const deletedSnapshotOlderEventId = "00000000-0000-4000-8000-0000000966c2";
const deletedSnapshotAnchorEventId = "00000000-0000-4000-8000-0000000966c3";
const ordinaryOrphanAgentId = "00000000-0000-4000-8000-0000000966c4";
const ordinaryOrphanThreadId = "00000000-0000-4000-8000-0000000966c5";
const ordinaryOrphanEventId = "00000000-0000-4000-8000-0000000966c6";
const matchedSearchRowCount = 1001;
const matchedSearchThreadIds = [
  "00000000-0000-4000-8000-0000000966b1",
  "00000000-0000-4000-8000-0000000966b2",
  "00000000-0000-4000-8000-0000000966b3",
] as const;

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

async function chatEventRejectFunctionDefinition(
  client: Client,
): Promise<string> {
  const result = await client.query<{ definition: string }>(`
    SELECT pg_get_functiondef(
      'public.reject_chat_event_source_update()'::regprocedure
    ) AS "definition"
  `);
  const definition = result.rows[0]?.definition;
  assert.ok(definition);
  return definition;
}

async function assertChatThreadEventAppendOnlyTriggerEnabled(
  client: Client,
): Promise<void> {
  const trigger = await client.query<{
    enabled: string;
    expectedFunction: boolean;
  }>(`
    SELECT
      "trigger"."tgenabled"::text AS "enabled",
      "trigger"."tgfoid" =
        'public.reject_chat_event_source_update()'::regprocedure
        AS "expectedFunction"
    FROM "pg_trigger" AS "trigger"
    WHERE "trigger"."tgrelid" = 'public.chat_thread_events'::regclass
      AND "trigger"."tgname" = 'chat_thread_events_reject_update'
      AND NOT "trigger"."tgisinternal"
  `);
  assert.deepEqual(trigger.rows, [{ enabled: "O", expectedFunction: true }]);
}

async function assertChatThreadEventUpdateRejected(
  client: Client,
  query: string,
  values: string[],
): Promise<void> {
  await assert.rejects(client.query(query, values), (error: unknown) => {
    assertDatabaseError(error, {
      code: "P0001",
      messageIncludes:
        "chat_thread_events is append-only; UPDATE is not allowed",
    });
    return true;
  });
}

function validateMigrationSql(migrationSql: string): void {
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(migrationSql, /\bDISABLE\s+TRIGGER\b/iu);
  assert.doesNotMatch(migrationSql, /\bsession_replication_role\b/iu);
  assert.doesNotMatch(migrationSql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
  assert.doesNotMatch(migrationSql, /\bRENAME\s+(?:TABLE|COLUMN)\b/iu);
  assert.match(migrationSql, /"tgenabled" = 'O'/u);
  assert.doesNotMatch(
    migrationSql,
    /CREATE\s+TRIGGER[\s\S]{0,300}\sON\s+"agents"/iu,
  );
  assert.equal(migrationSql.match(/LIMIT 500/gu)?.length, 3);
  assert.equal(migrationSql.match(/FOR UPDATE[^\n]*SKIP LOCKED/gu)?.length, 3);
  assert.equal(
    migrationSql.match(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /gmu)?.length,
    replacementIndexes.length,
  );
  assert.equal(
    migrationSql.match(/^CALL "backfill_agent_references_0966"/gmu)?.length,
    siblingColumns.length - 1,
  );
  assert.equal(
    migrationSql.match(
      /^CALL "backfill_chat_event_search_agent_references_0966"/gmu,
    )?.length,
    1,
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
  assert.equal(
    migrationSql.match(/^SET statement_timeout = '2h';$/gmu)?.length,
    1,
  );
  assert.doesNotMatch(
    migrationSql,
    /CALL "backfill_agent_references_0966"\('public\.chat_event_search_messages'/u,
  );
  assert.doesNotMatch(
    migrationSql,
    /(?:DROP|REINDEX)[^;]*chat_event_search_messages_tsv_idx/iu,
  );
  assert.match(
    migrationSql,
    /created_at"[\s\S]*greatest\("compose"\."updated_at", "zero_agent"\."updated_at"\)/u,
  );

  const chatThreadEventCall = `CALL "backfill_agent_references_0966"('public.chat_thread_events', ARRAY['id']::name[], 'agent_compose_id', 'agent_id', interval '30 seconds');`;
  const chatThreadEventCallOffset = migrationSql.indexOf(chatThreadEventCall);
  const narrowGuardOffset = migrationSql.indexOf(`AND OLD."agent_id" IS NULL`);
  const strictRestoreOffset = migrationSql.indexOf(
    `CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$`,
    chatThreadEventCallOffset + chatThreadEventCall.length,
  );
  const nextReferenceCallOffset = migrationSql.indexOf(
    `CALL "backfill_chat_event_search_agent_references_0966"`,
  );
  assert.ok(narrowGuardOffset > 0);
  assert.ok(narrowGuardOffset < chatThreadEventCallOffset);
  assert.ok(chatThreadEventCallOffset < strictRestoreOffset);
  assert.ok(strictRestoreOffset < nextReferenceCallOffset);
  assert.match(
    migrationSql,
    /TG_TABLE_SCHEMA = 'public'[\s\S]*TG_TABLE_NAME = 'chat_thread_events'[\s\S]*OLD\."agent_id" IS NULL[\s\S]*NEW\."agent_id" = OLD\."agent_compose_id"[\s\S]*\(to_jsonb\(NEW\) - 'agent_id'\) = \(to_jsonb\(OLD\) - 'agent_id'\)[\s\S]*FROM "agents" AS "agent"[\s\S]*"agent"\."id" = OLD\."agent_compose_id"/u,
  );

  const genericProcedureOffset = migrationSql.indexOf(
    `CREATE OR REPLACE PROCEDURE "backfill_agent_references_0966"`,
  );
  const searchProcedureOffset = migrationSql.indexOf(
    `CREATE OR REPLACE PROCEDURE "backfill_chat_event_search_agent_references_0966"`,
  );
  const firstReferenceCallOffset = migrationSql.indexOf(
    `CALL "backfill_agent_references_0966"`,
    searchProcedureOffset,
  );
  assert.ok(genericProcedureOffset > 0);
  assert.ok(genericProcedureOffset < searchProcedureOffset);
  assert.ok(searchProcedureOffset < firstReferenceCallOffset);
  const genericProcedureSql = migrationSql.slice(
    genericProcedureOffset,
    searchProcedureOffset,
  );
  const searchProcedureSql = migrationSql.slice(
    searchProcedureOffset,
    firstReferenceCallOffset,
  );
  assert.match(genericProcedureSql, /jsonb_build_array/u);
  assert.doesNotMatch(genericProcedureSql, /chat_event_search_messages/u);
  assert.doesNotMatch(searchProcedureSql, /jsonb_build_array|::text/u);
  assert.match(
    searchProcedureSql,
    /v_scan_after_chat_thread_id uuid := NULL;[\s\S]*v_scan_after_seq_id bigint := NULL;/u,
  );
  assert.match(
    searchProcedureSql,
    /\("source"\."chat_thread_id", "source"\."seq_id"\) >[\s\S]*\(v_scan_after_chat_thread_id, v_scan_after_seq_id\)/u,
  );
  assert.match(
    searchProcedureSql,
    /ORDER BY "source"\."chat_thread_id", "source"\."seq_id"[\s\S]*LIMIT 500[\s\S]*FOR UPDATE OF "source" SKIP LOCKED/u,
  );
  assert.match(
    searchProcedureSql,
    /INNER JOIN "agents" AS "agent"[\s\S]*"agent"\."id" = "scan"\."agent_compose_id"/u,
  );
  assert.match(
    searchProcedureSql,
    /SET "agent_id" = "target"\."agent_compose_id"/u,
  );

  const statements = splitMigrationStatements(migrationSql);
  const searchCallIndex = statements.findIndex((statement) => {
    return statement.startsWith(
      `CALL "backfill_chat_event_search_agent_references_0966"`,
    );
  });
  assert.ok(searchCallIndex > 0);
  assert.equal(
    statements[searchCallIndex - 1],
    "SET statement_timeout = '2h';",
  );
  assert.equal(
    statements[searchCallIndex + 1],
    "SET statement_timeout = '30min';",
  );

  const snapshotAnchorClassificationOffset = migrationSql.indexOf(
    `IF v_spec.table_oid = 'public.chat_thread_events'::regclass THEN`,
  );
  const genericClassificationOffset = migrationSql.indexOf(
    "    ELSE",
    snapshotAnchorClassificationOffset,
  );
  assert.ok(snapshotAnchorClassificationOffset > 0);
  assert.ok(genericClassificationOffset > snapshotAnchorClassificationOffset);
  const snapshotAnchorClassificationSql = migrationSql.slice(
    snapshotAnchorClassificationOffset,
    genericClassificationOffset,
  );
  assert.match(
    snapshotAnchorClassificationSql,
    /LEFT JOIN "agents" AS "agent"[\s\S]*LEFT JOIN "agent_composes" AS "compose"[\s\S]*LEFT JOIN "zero_agents" AS "zero_agent"/u,
  );
  assert.match(
    snapshotAnchorClassificationSql,
    /NOT EXISTS \([\s\S]*FROM "chat_threads" AS "live_thread"[\s\S]*"live_thread"\."id" = "source"\."chat_thread_id"/u,
  );
  assert.match(
    snapshotAnchorClassificationSql,
    /EXISTS \([\s\S]*FROM "chat_thread_snapshots" AS "snapshot"[\s\S]*"snapshot"\."user_id" = "source"\."user_id"[\s\S]*"snapshot"\."org_id" = "source"\."org_id"[\s\S]*"snapshot"\."latest_event_id" = "source"\."id"/u,
  );
  assert.match(
    snapshotAnchorClassificationSql,
    /"agent"\."id" IS NULL[\s\S]*"compose"\."id" IS NULL[\s\S]*"zero_agent"\."id" IS NULL[\s\S]*NOT EXISTS \([\s\S]*"chat_threads"[\s\S]*EXISTS \([\s\S]*"chat_thread_snapshots"/u,
  );
  assert.match(
    migrationSql,
    /deleted_snapshot_anchor_null %[\s\S]*v_deleted_snapshot_anchor_null/u,
  );
}

function validateCorrectionMigrationSql(migrationSql: string): void {
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(migrationSql, /\bDISABLE\s+TRIGGER\b/iu);
  assert.doesNotMatch(migrationSql, /\bsession_replication_role\b/iu);
  assert.doesNotMatch(migrationSql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
  assert.doesNotMatch(migrationSql, /\bRENAME\s+(?:TABLE|COLUMN)\b/iu);
  assert.doesNotMatch(migrationSql, /\bCREATE\s+TRIGGER\b/iu);
  assert.doesNotMatch(
    migrationSql,
    /\b(?:UPDATE|DELETE\s+FROM)\s+"(?:agent_composes|zero_agents|agent_sessions|chat_threads|chat_thread_events|chat_event_search_messages)"/iu,
  );
  assert.equal(
    migrationSql.match(
      /^CREATE OR REPLACE FUNCTION "sync_agent_from_legacy_0966"/gmu,
    )?.length,
    1,
  );
  const advisoryLockOffset = migrationSql.indexOf("pg_advisory_xact_lock");
  const firstSourceReadOffset = migrationSql.indexOf(
    'DELETE FROM "agents" AS "agent"',
  );
  assert.ok(advisoryLockOffset > 0);
  assert.ok(advisoryLockOffset < firstSourceReadOffset);
  assert.equal(migrationSql.match(/LIMIT 500/gu)?.length, 1);
  assert.equal(
    migrationSql.match(/FOR UPDATE OF "compose", "zero_agent" SKIP LOCKED/gu)
      ?.length,
    1,
  );
  assert.equal(
    migrationSql.match(/PERFORM "sync_agent_from_legacy_0966"\(v_agent_id\)/gu)
      ?.length,
    1,
  );
  assert.equal(
    migrationSql.match(
      /^CALL "repair_canonical_agents_0968"\(interval '30 seconds'\);$/gmu,
    )?.length,
    1,
  );
  assert.equal(
    migrationSql.match(
      /^DROP PROCEDURE IF EXISTS "repair_canonical_agents_0968"\(interval\);$/gmu,
    )?.length,
    1,
  );
  assert.match(migrationSql, /SET lock_timeout = '1s'/u);
  assert.match(migrationSql, /SET LOCAL lock_timeout = '1s'/u);
  assert.match(migrationSql, /transaction_timeout = '5min'/u);
  assert.match(migrationSql, /p_no_progress_timeout > interval '30 seconds'/u);
  assert.match(migrationSql, /Canonical Agent repair made no progress/u);
  assert.match(
    migrationSql,
    /v_compose_only_count_after <> v_compose_only_count_before/u,
  );
  assert.match(
    migrationSql,
    /v_compose_only_null_after <> v_compose_only_null_before/u,
  );
  assert.match(
    migrationSql,
    /v_deleted_snapshot_anchor_null_after <>[\s\S]*v_deleted_snapshot_anchor_null_before/u,
  );
  assert.match(migrationSql, /v_reference_unclassified_null <> 0/u);
  assert.match(migrationSql, /v_existing_final_missing <> 0/u);
  assert.match(
    migrationSql,
    /v_bridge_trigger_count <> 14 OR v_bridge_object_count <> 14/u,
  );
  assert.match(migrationSql, /v_target_trigger_count <> 0/u);
  assert.match(
    migrationSql,
    /greatest\("compose"\."updated_at", "zero_agent"\."updated_at"\)/u,
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

async function seedDeletedSnapshotAnchor(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" (
        "id", "user_id", "name", "org_id", "created_at", "updated_at"
      ) VALUES (
        $1, 'deleted-anchor-owner', 'deleted-anchor-agent',
        'deleted-anchor-org', timestamp '2026-01-01 00:00:00',
        timestamp '2026-01-02 00:00:00'
      )
    `,
    [deletedSnapshotAgentId],
  );
  await client.query(
    `
      INSERT INTO "zero_agents" (
        "id", "org_id", "owner", "name", "created_at", "updated_at"
      ) VALUES (
        $1, 'deleted-anchor-org', 'deleted-anchor-owner',
        'deleted-anchor-agent', timestamp '2026-01-01 00:00:00',
        timestamp '2026-01-02 00:00:00'
      )
    `,
    [deletedSnapshotAgentId],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" (
        "id", "user_id", "agent_compose_id", "title", "created_at",
        "updated_at"
      ) VALUES (
        $1, 'deleted-anchor-owner', $2, 'Deleted anchor thread',
        timestamp '2026-01-01 00:00:00', timestamp '2026-01-02 00:00:00'
      )
    `,
    [deletedSnapshotThreadId, deletedSnapshotAgentId],
  );
  await client.query(
    `
      INSERT INTO "chat_thread_events" (
        "id", "user_id", "org_id", "chat_thread_id", "kind",
        "agent_compose_id", "title", "created_at"
      ) VALUES
        (
          $1, 'deleted-anchor-owner', 'deleted-anchor-org', $3, 'created',
          $4, 'Deleted anchor thread', timestamp '2026-01-01 00:00:00'
        ),
        (
          $2, 'deleted-anchor-owner', 'deleted-anchor-org', $3, 'deleted',
          $4, NULL, timestamp '2026-01-02 00:00:00'
        )
    `,
    [
      deletedSnapshotOlderEventId,
      deletedSnapshotAnchorEventId,
      deletedSnapshotThreadId,
      deletedSnapshotAgentId,
    ],
  );

  await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    deletedSnapshotAgentId,
  ]);
  const cascaded = await client.query<{
    composeCount: number;
    eventCount: number;
    threadCount: number;
    zeroAgentCount: number;
  }>(
    `
      SELECT
        (SELECT count(*)::integer FROM "agent_composes" WHERE "id" = $1)
          AS "composeCount",
        (SELECT count(*)::integer FROM "zero_agents" WHERE "id" = $1)
          AS "zeroAgentCount",
        (SELECT count(*)::integer FROM "chat_threads" WHERE "id" = $2)
          AS "threadCount",
        (
          SELECT count(*)::integer FROM "chat_thread_events"
          WHERE "id" = ANY($3::uuid[])
        ) AS "eventCount"
    `,
    [
      deletedSnapshotAgentId,
      deletedSnapshotThreadId,
      [deletedSnapshotOlderEventId, deletedSnapshotAnchorEventId],
    ],
  );
  assert.deepEqual(cascaded.rows, [
    { composeCount: 0, zeroAgentCount: 0, threadCount: 0, eventCount: 2 },
  ]);

  await client.query(
    `
      INSERT INTO "chat_thread_snapshots" (
        "user_id", "org_id", "latest_event_id", "latest_event_seq_id",
        "chat_threads", "created_at", "updated_at"
      )
      SELECT
        "event"."user_id", "event"."org_id", "event"."id",
        "event"."seq_id", '[]'::jsonb, timestamp '2026-02-01 00:00:00',
        timestamp '2026-02-01 00:00:00'
      FROM "chat_thread_events" AS "event"
      WHERE "event"."id" = $1
    `,
    [deletedSnapshotAnchorEventId],
  );
  const compacted = await client.query<{ prunedCount: number }>(`
    WITH "pruned" AS (
      DELETE FROM "chat_thread_events" AS "event"
      USING "chat_thread_snapshots" AS "snapshot"
      INNER JOIN "chat_thread_events" AS "marker"
        ON "marker"."id" = "snapshot"."latest_event_id"
        AND "marker"."seq_id" = "snapshot"."latest_event_seq_id"
        AND "marker"."user_id" = "snapshot"."user_id"
        AND "marker"."org_id" = "snapshot"."org_id"
      WHERE "event"."user_id" = "snapshot"."user_id"
        AND "event"."org_id" = "snapshot"."org_id"
        AND "event"."created_at" < timestamp '2026-02-01 00:00:00'
        AND "event"."seq_id" < "marker"."seq_id"
      RETURNING 1
    )
    SELECT count(*)::integer AS "prunedCount" FROM "pruned"
  `);
  assert.deepEqual(compacted.rows, [{ prunedCount: 1 }]);

  const retained = await client.query<{
    anchorCount: number;
    olderCount: number;
    snapshotCount: number;
  }>(
    `
      SELECT
        (
          SELECT count(*)::integer FROM "chat_thread_events"
          WHERE "id" = $1
        ) AS "anchorCount",
        (
          SELECT count(*)::integer FROM "chat_thread_events"
          WHERE "id" = $2
        ) AS "olderCount",
        (
          SELECT count(*)::integer FROM "chat_thread_snapshots"
          WHERE "user_id" = 'deleted-anchor-owner'
            AND "org_id" = 'deleted-anchor-org'
            AND "latest_event_id" = $1
        ) AS "snapshotCount"
    `,
    [deletedSnapshotAnchorEventId, deletedSnapshotOlderEventId],
  );
  assert.deepEqual(retained.rows, [
    { anchorCount: 1, olderCount: 0, snapshotCount: 1 },
  ]);
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
      SELECT "thread_id", 'canonical-owner', $2
      FROM unnest($1::uuid[]) AS "fixture"("thread_id")
    `,
    [[...matchedSearchThreadIds], fixedAgentId],
  );
  await client.query(
    `
      INSERT INTO "chat_event_search_messages" (
        "chat_thread_id", "seq_id", "user_id", "org_id",
        "agent_compose_id", "role", "created_at", "text", "text_bigram"
      )
      SELECT
        ($1::uuid[])[1 + (("position" - 1) / 334)],
        1 + (("position" - 1) % 334),
        'canonical-owner', 'canonical-org', $2,
        CASE WHEN "position" % 2 = 0 THEN 'assistant' ELSE 'user' END,
        timestamp '2026-08-21 00:00:00' + "position" * interval '1 second',
        'production search message ' || "position",
        'productionsearchtoken ' || "position"
      FROM generate_series(1, $3::integer) AS "fixture"("position")
    `,
    [[...matchedSearchThreadIds], fixedAgentId, matchedSearchRowCount],
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
  await client.query(
    `
      INSERT INTO "chat_thread_events" (
        "id", "user_id", "org_id", "chat_thread_id", "kind",
        "agent_compose_id", "title"
      ) VALUES
        (
          $1, 'canonical-owner', 'canonical-org',
          '00000000-0000-4000-8000-0000000966a1', 'created', $3,
          'canonical Agent event'
        ),
        (
          $2, 'compose-only-owner', 'compose-only-org',
          '00000000-0000-4000-8000-0000000966aa', 'created', $4,
          'compose-only event'
        )
    `,
    [
      fixedChatThreadEventId,
      composeOnlyChatThreadEventId,
      fixedAgentId,
      composeOnlyId,
    ],
  );
  await seedDeletedSnapshotAnchor(client);
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

async function explainWithSequentialScansDisabled(
  client: Client,
  query: string,
  values: string[],
  disableBitmapScans = false,
): Promise<string> {
  await client.query("BEGIN");
  await client.query("SET LOCAL enable_seqscan = off");
  if (disableBitmapScans) {
    await client.query("SET LOCAL enable_bitmapscan = off");
  }
  const result = await client.query<{
    readonly "QUERY PLAN": unknown;
  }>(query, values);
  await client.query("COMMIT");
  const plan = result.rows[0]?.["QUERY PLAN"];
  assert.ok(plan);
  return JSON.stringify(plan);
}

async function assertChatSearchNativePrimaryKeyPlan(
  client: Client,
): Promise<void> {
  const plan = await explainWithSequentialScansDisabled(
    client,
    `
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT "source"."chat_thread_id", "source"."seq_id"
      FROM "chat_event_search_messages" AS "source"
      WHERE ("source"."chat_thread_id", "source"."seq_id") >
          ($1::uuid, $2::bigint)
        AND "source"."agent_id" IS DISTINCT FROM
          "source"."agent_compose_id"
      ORDER BY "source"."chat_thread_id", "source"."seq_id"
      LIMIT 500
      FOR UPDATE OF "source" SKIP LOCKED
    `,
    [matchedSearchThreadIds[0], "0"],
    true,
  );
  assert.ok(
    plan.includes(
      '"Index Name":"chat_event_search_messages_chat_thread_id_seq_id_pk"',
    ),
    plan,
  );
  assert.ok(!plan.includes('"Node Type":"Sort"'), plan);
}

async function assertChatSearchBackfillContention(args: {
  readonly blocker: Client;
  readonly runner: Client;
  readonly statements: readonly string[];
}): Promise<void> {
  const callIndex = args.statements.findIndex((statement) => {
    return statement.startsWith(
      `CALL "backfill_chat_event_search_agent_references_0966"`,
    );
  });
  assert.ok(callIndex > 0);

  await executeStatements({
    client: args.runner,
    statements: args.statements,
    endExclusive: callIndex,
  });
  await assertChatSearchNativePrimaryKeyPlan(args.runner);

  const locked = await args.runner.query<{
    chatThreadId: string;
    seqId: string;
  }>(
    `
      SELECT "chat_thread_id"::text AS "chatThreadId",
        "seq_id"::text AS "seqId"
      FROM "chat_event_search_messages"
      WHERE "agent_compose_id" = $1
      ORDER BY "chat_thread_id", "seq_id"
      LIMIT 1
    `,
    [fixedAgentId],
  );
  assert.equal(locked.rows.length, 1);
  await args.blocker.query("BEGIN");
  await args.blocker.query(
    `
      SELECT 1
      FROM "chat_event_search_messages"
      WHERE "chat_thread_id" = $1 AND "seq_id" = $2::bigint
      FOR UPDATE
    `,
    [locked.rows[0]!.chatThreadId, locked.rows[0]!.seqId],
  );
  try {
    await assert.rejects(
      args.runner.query(
        `CALL "backfill_chat_event_search_agent_references_0966"(interval '100 milliseconds')`,
      ),
      (error: unknown) => {
        assertDatabaseError(error, {
          code: "P0001",
          messageIncludes:
            "Canonical Agent search reference backfill made no progress",
        });
        return true;
      },
    );
  } finally {
    await args.blocker.query("ROLLBACK");
  }

  const interrupted = await args.runner.query<{
    composeOnlyNullCount: number;
    matchedNullCount: number;
    matchedTargetCount: number;
  }>(
    `
      SELECT
        count(*) FILTER (
          WHERE "agent_compose_id" = $1 AND "agent_id" = $1
        )::integer AS "matchedTargetCount",
        count(*) FILTER (
          WHERE "agent_compose_id" = $1 AND "agent_id" IS NULL
        )::integer AS "matchedNullCount",
        count(*) FILTER (
          WHERE "agent_compose_id" = $2 AND "agent_id" IS NULL
        )::integer AS "composeOnlyNullCount"
      FROM "chat_event_search_messages"
    `,
    [fixedAgentId, composeOnlyId],
  );
  assert.deepEqual(interrupted.rows, [
    {
      matchedTargetCount: matchedSearchRowCount - 1,
      matchedNullCount: 1,
      composeOnlyNullCount: 2,
    },
  ]);

  await args.runner.query(
    `CALL "backfill_chat_event_search_agent_references_0966"(interval '30 seconds')`,
  );
  await args.runner.query(
    `CALL "backfill_chat_event_search_agent_references_0966"(interval '30 seconds')`,
  );
  await args.runner.query(args.statements[callIndex + 1]!);

  const committedBatches = await args.runner.query<{
    largestBatch: number;
    matchedTargetCount: number;
    transactionCount: number;
  }>(
    `
      SELECT
        sum("batch_count")::integer AS "matchedTargetCount",
        count(*)::integer AS "transactionCount",
        max("batch_count")::integer AS "largestBatch"
      FROM (
        SELECT "xmin"::text, count(*)::integer AS "batch_count"
        FROM "chat_event_search_messages"
        WHERE "agent_compose_id" = $1 AND "agent_id" = $1
        GROUP BY "xmin"::text
      ) AS "committed_batch"
    `,
    [fixedAgentId],
  );
  assert.deepEqual(committedBatches.rows, [
    {
      matchedTargetCount: matchedSearchRowCount,
      transactionCount: 4,
      largestBatch: 500,
    },
  ]);
}

async function assertChatThreadEventReferenceState(
  client: Client,
): Promise<void> {
  const references = await client.query<{
    agentId: string | null;
    id: string;
  }>(
    `
      SELECT "id"::text AS "id", "agent_id"::text AS "agentId"
      FROM "chat_thread_events"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
    [[fixedChatThreadEventId, composeOnlyChatThreadEventId]],
  );
  assert.deepEqual(references.rows, [
    { id: fixedChatThreadEventId, agentId: fixedAgentId },
    { id: composeOnlyChatThreadEventId, agentId: null },
  ]);
}

async function assertDeletedSnapshotAnchorState(client: Client): Promise<void> {
  const state = await client.query<{
    agentCount: number;
    agentId: string | null;
    composeCount: number;
    eventCount: number;
    snapshotCount: number;
    threadCount: number;
    zeroAgentCount: number;
  }>(
    `
      SELECT
        (
          SELECT count(*)::integer FROM "chat_thread_events"
          WHERE "id" = $1
        ) AS "eventCount",
        (
          SELECT "agent_id"::text FROM "chat_thread_events"
          WHERE "id" = $1
        ) AS "agentId",
        (
          SELECT count(*)::integer FROM "agents" WHERE "id" = $2
        ) AS "agentCount",
        (
          SELECT count(*)::integer FROM "agent_composes" WHERE "id" = $2
        ) AS "composeCount",
        (
          SELECT count(*)::integer FROM "zero_agents" WHERE "id" = $2
        ) AS "zeroAgentCount",
        (
          SELECT count(*)::integer FROM "chat_threads" WHERE "id" = $3
        ) AS "threadCount",
        (
          SELECT count(*)::integer FROM "chat_thread_snapshots"
          WHERE "user_id" = 'deleted-anchor-owner'
            AND "org_id" = 'deleted-anchor-org'
            AND "latest_event_id" = $1
        ) AS "snapshotCount"
    `,
    [
      deletedSnapshotAnchorEventId,
      deletedSnapshotAgentId,
      deletedSnapshotThreadId,
    ],
  );
  assert.deepEqual(state.rows, [
    {
      eventCount: 1,
      agentId: null,
      agentCount: 0,
      composeCount: 0,
      zeroAgentCount: 0,
      threadCount: 0,
      snapshotCount: 1,
    },
  ]);
}

async function assertOrdinaryOrphanFailsPostflight(args: {
  readonly runner: Client;
  readonly statements: readonly string[];
}): Promise<void> {
  const postflight = args.statements.find((statement) => {
    return statement.includes(
      "Canonical Agent reference parity failed for %: valid_missing %",
    );
  });
  assert.ok(postflight);

  await args.runner.query(
    `
      INSERT INTO "chat_thread_events" (
        "id", "user_id", "org_id", "chat_thread_id", "kind",
        "agent_compose_id", "title", "created_at"
      ) VALUES (
        $1, 'ordinary-orphan-owner', 'ordinary-orphan-org', $2, 'created',
        $3, 'Ordinary orphan', timestamp '2026-01-03 00:00:00'
      )
    `,
    [ordinaryOrphanEventId, ordinaryOrphanThreadId, ordinaryOrphanAgentId],
  );
  const orphan = await args.runner.query<{ agentId: string | null }>(
    `
      SELECT "agent_id"::text AS "agentId"
      FROM "chat_thread_events" WHERE "id" = $1
    `,
    [ordinaryOrphanEventId],
  );
  assert.deepEqual(orphan.rows, [{ agentId: null }]);

  await assert.rejects(args.runner.query(postflight), (error: unknown) => {
    assertDatabaseError(error, {
      code: "P0001",
      messageIncludes: "unclassified_null 1",
    });
    return true;
  });

  await args.runner.query(`DELETE FROM "chat_thread_events" WHERE "id" = $1`, [
    ordinaryOrphanEventId,
  ]);
  await args.runner.query(postflight);
}

async function assertChatThreadEventBackfillGuard(args: {
  readonly runner: Client;
  readonly statements: readonly string[];
  readonly strictRejectFunctionDefinition: string;
}): Promise<void> {
  const callIndex = args.statements.findIndex((statement) => {
    return statement.startsWith(
      `CALL "backfill_agent_references_0966"('public.chat_thread_events'`,
    );
  });
  assert.ok(callIndex > 1);
  const catalogGate = args.statements[callIndex - 2];
  const narrowGuard = args.statements[callIndex - 1];
  const strictRestore = args.statements[callIndex + 1];
  assert.match(catalogGate!, /"tgenabled" = 'O'/u);
  assert.match(
    narrowGuard!,
    /OLD\."agent_id" IS NULL[\s\S]*NEW\."agent_id" = OLD\."agent_compose_id"/u,
  );
  assert.doesNotMatch(strictRestore!, /OLD\."agent_id"/u);

  await args.runner.query(
    `ALTER TABLE "chat_thread_events" ENABLE REPLICA TRIGGER "chat_thread_events_reject_update"`,
  );
  await assert.rejects(args.runner.query(catalogGate!), (error: unknown) => {
    assertDatabaseError(error, {
      code: "P0001",
      messageIncludes: "chat_thread_events append-only trigger must be enabled",
    });
    return true;
  });
  await args.runner.query(
    `ALTER TABLE "chat_thread_events" ENABLE TRIGGER "chat_thread_events_reject_update"`,
  );

  // Stop immediately before the guarded call to model an interrupted run with
  // the permanent trigger still enabled and the narrow transition installed.
  await executeStatements({
    client: args.runner,
    statements: args.statements,
    endExclusive: callIndex,
  });
  await assertChatThreadEventAppendOnlyTriggerEnabled(args.runner);
  await assertChatThreadEventUpdateRejected(
    args.runner,
    `UPDATE "chat_thread_events" SET "title" = 'forbidden' WHERE "id" = $1`,
    [fixedChatThreadEventId],
  );
  await assertChatThreadEventUpdateRejected(
    args.runner,
    `UPDATE "chat_thread_events" SET "agent_id" = "agent_compose_id", "title" = 'forbidden' WHERE "id" = $1`,
    [fixedChatThreadEventId],
  );
  await assertChatThreadEventUpdateRejected(
    args.runner,
    `UPDATE "chat_thread_events" SET "agent_id" = "agent_compose_id" WHERE "id" = $1`,
    [composeOnlyChatThreadEventId],
  );

  await args.runner.query(args.statements[callIndex]!);
  await args.runner.query(args.statements[callIndex]!);
  await args.runner.query(strictRestore!);

  await assertChatThreadEventReferenceState(args.runner);
  await assertChatThreadEventAppendOnlyTriggerEnabled(args.runner);
  assert.equal(
    await chatEventRejectFunctionDefinition(args.runner),
    args.strictRejectFunctionDefinition,
  );
  await assertChatThreadEventUpdateRejected(
    args.runner,
    `UPDATE "chat_thread_events" SET "agent_id" = NULL WHERE "id" = $1`,
    [fixedChatThreadEventId],
  );
  await assertChatThreadEventUpdateRejected(
    args.runner,
    `UPDATE "chat_thread_events" SET "title" = 'still forbidden' WHERE "id" = $1`,
    [composeOnlyChatThreadEventId],
  );
}

async function validateChatSearchStorageAndIndex(
  client: Client,
): Promise<void> {
  const storage = await client.query<{
    generatedKind: string;
    indexedCount: number;
    indexDefinition: string;
    ready: boolean;
    valid: boolean;
  }>(
    `
      SELECT
        "attribute"."attgenerated"::text AS "generatedKind",
        "index"."indisready" AS "ready",
        "index"."indisvalid" AS "valid",
        pg_get_indexdef("index"."indexrelid") AS "indexDefinition",
        (
          SELECT count(*)::integer
          FROM "chat_event_search_messages"
          WHERE "agent_compose_id" = $1
            AND "tsv" @@ to_tsquery('simple', 'productionsearchtoken')
        ) AS "indexedCount"
      FROM "pg_attribute" AS "attribute"
      INNER JOIN "pg_index" AS "index"
        ON "index"."indrelid" = "attribute"."attrelid"
      INNER JOIN "pg_class" AS "index_relation"
        ON "index_relation"."oid" = "index"."indexrelid"
      WHERE "attribute"."attrelid" =
          'public.chat_event_search_messages'::regclass
        AND "attribute"."attname" = 'tsv'
        AND "index_relation"."relname" =
          'chat_event_search_messages_tsv_idx'
    `,
    [fixedAgentId],
  );
  assert.equal(storage.rows.length, 1);
  assert.equal(storage.rows[0]!.generatedKind, "s");
  assert.equal(storage.rows[0]!.ready, true);
  assert.equal(storage.rows[0]!.valid, true);
  assert.equal(storage.rows[0]!.indexedCount, matchedSearchRowCount);
  assert.match(storage.rows[0]!.indexDefinition, /USING gin \(tsv\)$/u);

  const plan = await explainWithSequentialScansDisabled(
    client,
    `
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT "chat_thread_id", "seq_id"
      FROM "chat_event_search_messages"
      WHERE "tsv" @@ to_tsquery('simple', 'productionsearchtoken')
    `,
    [],
  );
  assert.ok(
    plan.includes('"Index Name":"chat_event_search_messages_tsv_idx"'),
    plan,
  );
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
        'backfill_chat_event_search_agent_references_0966',
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
    composeOnlyThreadEventNullCount: number;
    composeOnlyThreadNullCount: number;
    fieldMismatchCount: number;
    matchedSearchCount: number;
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
        SELECT count(*)::integer FROM "chat_thread_events"
        WHERE "agent_compose_id" = $1 AND "agent_id" IS NULL
      ) AS "composeOnlyThreadEventNullCount",
      (
        SELECT count(*)::integer FROM "chat_event_search_messages"
        WHERE "agent_compose_id" = $1 AND "agent_id" IS NULL
      ) AS "composeOnlySearchNullCount",
      (
        SELECT count(*)::integer FROM "chat_event_search_messages"
        WHERE "agent_compose_id" = $2 AND "agent_id" = $2
      ) AS "matchedSearchCount"
  `,
    [composeOnlyId, fixedAgentId],
  );
  assert.deepEqual(parity.rows, [
    {
      matchedCount: 502,
      targetCount: 502,
      fieldMismatchCount: 0,
      composeOnlyAgentCount: 0,
      composeOnlySessionNullCount: 22,
      composeOnlyThreadNullCount: 1,
      composeOnlyThreadEventNullCount: 1,
      composeOnlySearchNullCount: 2,
      matchedSearchCount: matchedSearchRowCount,
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

async function waitForAbsentTargetWriterState(
  client: Client,
  backendPid: number,
  queryIncludes: string,
): Promise<"blocked" | "completed"> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await client.query<{
      query: string;
      state: string;
      waitEvent: string | null;
      waitEventType: string | null;
    }>(
      `
        SELECT "query", "state", "wait_event" AS "waitEvent",
          "wait_event_type" AS "waitEventType"
        FROM "pg_stat_activity"
        WHERE "pid" = $1
      `,
      [backendPid],
    );
    const state = activity.rows[0];
    if (!state?.query.includes(queryIncludes)) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      continue;
    }
    if (state?.waitEventType === "Lock" && state.waitEvent === "advisory") {
      return "blocked";
    }
    if (state?.state === "idle in transaction") {
      return "completed";
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail("absent-target writer reached no synchronized backend state");
}

const absentTargetAgentId = "00000000-0000-4000-8000-0000000966e3";

async function seedAbsentTargetCompose(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" (
        "id", "user_id", "name", "org_id", "created_at", "updated_at"
      ) VALUES (
        $1, 'absent-target-owner', 'absent-target-agent',
        'absent-target-org', timestamp '2026-05-01 00:00:00',
        timestamp '2026-05-02 00:00:00'
      )
    `,
    [absentTargetAgentId],
  );
}

function insertAbsentTargetProduct(client: Client): Promise<unknown> {
  return client.query(
    `
      INSERT INTO "zero_agents" (
        "id", "org_id", "owner", "name", "visibility", "display_name",
        "description", "sound", "avatar_url", "model_provider_id",
        "selected_model", "prefer_personal_provider", "updated_at"
      ) VALUES (
        $1, 'absent-target-org', 'absent-target-owner',
        'absent-target-agent', 'private', 'Absent Target Agent',
        'absent-target description', 'absent-target-sound',
        'https://example.test/absent-target.png', NULL,
        'absent-target-model', true, timestamp '2026-05-01 12:00:00'
      )
    `,
    [absentTargetAgentId],
  );
}

async function runAbsentTargetProductFirstRace(
  observer: Client,
  testUrl: string,
): Promise<"blocked" | "completed"> {
  await seedAbsentTargetCompose(observer);

  const productWriter = await connect(testUrl);
  const composeWriter = await connect(testUrl);
  let composeUpdate: Promise<unknown> | undefined;
  let writerState: "blocked" | "completed" | undefined;
  try {
    const backend = await composeWriter.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    const backendPid = backend.rows[0]!.pid;

    await productWriter.query("BEGIN");
    await insertAbsentTargetProduct(productWriter);
    const published = await productWriter.query<{ updatedAt: string }>(
      `
        SELECT to_char("updated_at", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
        FROM "agents" WHERE "id" = $1
      `,
      [absentTargetAgentId],
    );
    assert.deepEqual(published.rows, [{ updatedAt: "2026-05-02 00:00:00" }]);

    await composeWriter.query("BEGIN");
    composeUpdate = composeWriter.query(
      `
        UPDATE "agent_composes"
        SET "updated_at" = timestamp '2026-05-03 00:00:00'
        WHERE "id" = $1
      `,
      [absentTargetAgentId],
    );
    writerState = await waitForAbsentTargetWriterState(
      observer,
      backendPid,
      'UPDATE "agent_composes"',
    );

    await productWriter.query("COMMIT");
    await composeUpdate;
    composeUpdate = undefined;
    await composeWriter.query("COMMIT");
  } finally {
    await productWriter.query("ROLLBACK").catch(() => {});
    await composeUpdate?.catch(() => {});
    await composeWriter.query("ROLLBACK").catch(() => {});
    await productWriter.end();
    await composeWriter.end();
  }

  assert.ok(writerState);
  return writerState;
}

async function runAbsentTargetComposeFirstRace(
  observer: Client,
  testUrl: string,
): Promise<void> {
  await seedAbsentTargetCompose(observer);

  const composeWriter = await connect(testUrl);
  const productWriter = await connect(testUrl);
  let productInsert: Promise<unknown> | undefined;
  try {
    const backend = await productWriter.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    const backendPid = backend.rows[0]!.pid;

    await composeWriter.query("BEGIN");
    await composeWriter.query(
      `
        UPDATE "agent_composes"
        SET "updated_at" = timestamp '2026-05-03 00:00:00'
        WHERE "id" = $1
      `,
      [absentTargetAgentId],
    );

    await productWriter.query("BEGIN");
    productInsert = insertAbsentTargetProduct(productWriter);
    const writerState = await waitForAbsentTargetWriterState(
      observer,
      backendPid,
      'INSERT INTO "zero_agents"',
    );
    assert.equal(writerState, "blocked");

    await composeWriter.query("COMMIT");
    await productInsert;
    productInsert = undefined;
    await productWriter.query("COMMIT");
  } finally {
    await composeWriter.query("ROLLBACK").catch(() => {});
    await productInsert?.catch(() => {});
    await productWriter.query("ROLLBACK").catch(() => {});
    await composeWriter.end();
    await productWriter.end();
  }
}

async function assertAbsentTargetCanonicalRow(
  observer: Client,
  updatedAt: string,
): Promise<void> {
  const canonical = await observer.query<{
    avatarUrl: string | null;
    createdAt: string;
    description: string | null;
    displayName: string | null;
    id: string;
    modelProviderId: string | null;
    name: string;
    orgId: string;
    owner: string;
    preferPersonalProvider: boolean;
    selectedModel: string | null;
    sound: string | null;
    updatedAt: string;
    visibility: string;
  }>(
    `
      SELECT "id"::text AS "id", "org_id" AS "orgId", "owner", "name",
        "visibility", "display_name" AS "displayName", "description", "sound",
        "avatar_url" AS "avatarUrl",
        "model_provider_id"::text AS "modelProviderId",
        "selected_model" AS "selectedModel",
        "prefer_personal_provider" AS "preferPersonalProvider",
        to_char("created_at", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
        to_char("updated_at", 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt"
      FROM "agents" WHERE "id" = $1
    `,
    [absentTargetAgentId],
  );
  assert.deepEqual(canonical.rows, [
    {
      id: absentTargetAgentId,
      orgId: "absent-target-org",
      owner: "absent-target-owner",
      name: "absent-target-agent",
      visibility: "private",
      displayName: "Absent Target Agent",
      description: "absent-target description",
      sound: "absent-target-sound",
      avatarUrl: "https://example.test/absent-target.png",
      modelProviderId: null,
      selectedModel: "absent-target-model",
      preferPersonalProvider: true,
      createdAt: "2026-05-01 00:00:00",
      updatedAt,
    },
  ]);
}

async function canonicalSourceTimestampDigest(client: Client): Promise<{
  composeDigest: string;
  productDigest: string;
}> {
  const result = await client.query<{
    composeDigest: string;
    productDigest: string;
  }>(`
    SELECT
      (
        SELECT md5(string_agg(
          "id"::text || '|' || "created_at"::text || '|' || "updated_at"::text,
          ',' ORDER BY "id"
        ))
        FROM "agent_composes"
      ) AS "composeDigest",
      (
        SELECT md5(string_agg(
          "id"::text || '|' || "created_at"::text || '|' || "updated_at"::text,
          ',' ORDER BY "id"
        ))
        FROM "zero_agents"
      ) AS "productDigest"
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function canonicalTimestampMismatchCount(
  client: Client,
): Promise<number> {
  const result = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "agent_composes" AS "compose"
    INNER JOIN "zero_agents" AS "zero_agent"
      ON "zero_agent"."id" = "compose"."id"
    INNER JOIN "agents" AS "agent"
      ON "agent"."id" = "compose"."id"
    WHERE "agent"."updated_at" IS DISTINCT FROM
      greatest("compose"."updated_at", "zero_agent"."updated_at")
  `);
  return result.rows[0]!.count;
}

async function assertCanonicalRepairContention(args: {
  readonly blocker: Client;
  readonly runner: Client;
  readonly statements: readonly string[];
}): Promise<void> {
  const callIndex = args.statements.findIndex((statement) => {
    return (
      statement ===
      `CALL "repair_canonical_agents_0968"(interval '30 seconds');`
    );
  });
  assert.ok(callIndex > 0);

  await executeStatements({
    client: args.runner,
    statements: args.statements,
    endExclusive: callIndex,
  });

  const sourceDigest = await canonicalSourceTimestampDigest(args.runner);
  await args.runner.query(
    `
      UPDATE "agents"
      SET "updated_at" = timestamp '2000-01-01 00:00:00'
      WHERE "id" <> $1
    `,
    [absentTargetAgentId],
  );
  const initialMismatchCount = await canonicalTimestampMismatchCount(
    args.runner,
  );
  assert.ok(initialMismatchCount > 500);

  await args.blocker.query("BEGIN");
  await args.blocker.query(
    `SELECT 1 FROM "zero_agents" WHERE "id" = $1 FOR UPDATE`,
    [fixedAgentId],
  );
  try {
    await assert.rejects(
      args.runner.query(
        `CALL "repair_canonical_agents_0968"(interval '100 milliseconds')`,
      ),
      (error: unknown) => {
        assertDatabaseError(error, {
          messageIncludes: "Canonical Agent repair made no progress",
        });
        return true;
      },
    );
  } finally {
    await args.blocker.query("ROLLBACK");
  }

  assert.equal(await canonicalTimestampMismatchCount(args.runner), 1);
  assert.deepEqual(
    await canonicalSourceTimestampDigest(args.runner),
    sourceDigest,
  );
  await assertAbsentTargetCanonicalRow(args.runner, "2026-05-03 00:00:00");
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
  const correctionMigrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${correctionMigration}.sql`),
    "utf8",
  );
  validateCorrectionMigrationSql(correctionMigrationSql);
  const correctionStatements = splitMigrationStatements(correctionMigrationSql);

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
    await assertChatThreadEventAppendOnlyTriggerEnabled(runner);
    const strictRejectFunctionDefinition =
      await chatEventRejectFunctionDefinition(runner);
    const baseline = await collectCatalogBaseline(runner);

    await assertCatalogLockRetryBoundary({ blocker, runner, statements });
    await assertAgentBackfillContention({ blocker, runner, statements });
    await assertReferenceBackfillContention({ blocker, runner, statements });
    await assertChatThreadEventBackfillGuard({
      runner,
      statements,
      strictRejectFunctionDefinition,
    });
    await assertChatSearchBackfillContention({ blocker, runner, statements });

    await executeStatements({ client: runner, statements });
    await validateFinalCatalog(runner, baseline);
    await validateBackfillAndComposeOnlyClosure(runner);
    await validateChatSearchStorageAndIndex(runner);
    await assertChatThreadEventReferenceState(runner);
    await assertDeletedSnapshotAnchorState(runner);
    await assertOrdinaryOrphanFailsPostflight({ runner, statements });
    await assertChatThreadEventAppendOnlyTriggerEnabled(runner);
    assert.equal(
      await chatEventRejectFunctionDefinition(runner),
      strictRejectFunctionDefinition,
    );
    await validateBridgeBehavior(runner);
    await validateConcurrentBridgeBehavior(runner, testUrl);
    await validateInvalidIndexRecovery({ client: runner, statements });
    await validateFinalCatalog(runner, baseline);
    await validateBackfillAndComposeOnlyClosure(runner);
    await validateChatSearchStorageAndIndex(runner);
    await assertChatThreadEventReferenceState(runner);
    await assertDeletedSnapshotAnchorState(runner);
    await assertChatThreadEventAppendOnlyTriggerEnabled(runner);
    assert.equal(
      await chatEventRejectFunctionDefinition(runner),
      strictRejectFunctionDefinition,
    );

    const preCorrectionWriterState = await runAbsentTargetProductFirstRace(
      runner,
      testUrl,
    );
    assert.equal(preCorrectionWriterState, "completed");
    await assertAbsentTargetCanonicalRow(runner, "2026-05-02 00:00:00");

    await assertCanonicalRepairContention({
      blocker,
      runner,
      statements: correctionStatements,
    });
    await executeStatements({
      client: runner,
      statements: correctionStatements,
    });
    await executeStatements({
      client: runner,
      statements: correctionStatements,
    });

    await validateBridgeBehavior(runner);
    await validateConcurrentBridgeBehavior(runner, testUrl);
    await runner.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
      absentTargetAgentId,
    ]);
    const postCorrectionWriterState = await runAbsentTargetProductFirstRace(
      runner,
      testUrl,
    );
    assert.equal(postCorrectionWriterState, "blocked");
    await assertAbsentTargetCanonicalRow(runner, "2026-05-03 00:00:00");

    await runner.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
      absentTargetAgentId,
    ]);
    await runAbsentTargetComposeFirstRace(runner, testUrl);
    await assertAbsentTargetCanonicalRow(runner, "2026-05-03 00:00:00");
    await runner.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
      absentTargetAgentId,
    ]);

    await validateFinalCatalog(runner, baseline);
    await validateBackfillAndComposeOnlyClosure(runner);
    await validateChatSearchStorageAndIndex(runner);
    await assertChatThreadEventReferenceState(runner);
    await assertDeletedSnapshotAnchorState(runner);
    await assertChatThreadEventAppendOnlyTriggerEnabled(runner);
    assert.equal(
      await chatEventRejectFunctionDefinition(runner),
      strictRejectFunctionDefinition,
    );
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
