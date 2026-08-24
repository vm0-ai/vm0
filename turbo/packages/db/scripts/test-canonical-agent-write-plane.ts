import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");
const previousMigration = "0973_backfill_agent_run_built_in_model_key_ids";
const migration = "0974_canonical_agent_writes";
const upgradeDatabase = "migration_canonical_agent_write_plane";
const freshDatabase = "migration_canonical_agent_write_plane_fresh";
const agentId = "00000000-0000-4000-8000-000000097201";
const secondAgentId = "00000000-0000-4000-8000-000000097202";
const canonicalOnlyAgentId = "00000000-0000-4000-8000-000000097203";
const composeOnlyId = "00000000-0000-4000-8000-0000000972ff";

const nullableLegacyColumns = [
  ["agent_sessions", "agent_compose_id"],
  ["chat_threads", "agent_compose_id"],
  ["chat_thread_events", "agent_compose_id"],
  ["chat_event_search_messages", "agent_compose_id"],
  ["telegram_installations", "default_compose_id"],
  ["feishu_org_installations", "default_compose_id"],
  ["github_installations", "default_compose_id"],
] as const;

const immutableReferenceChecks = [
  "agent_sessions_agent_reference_match",
  "chat_threads_agent_reference_match",
  "chat_thread_events_agent_reference_match",
  "chat_event_search_messages_agent_reference_match",
  "github_installations_agent_reference_match",
  "agentphone_user_agent_preferences_agent_reference_match",
] as const;

const requiredMutableReferenceChecks = [
  "telegram_installations_agent_reference_match",
  "feishu_org_installations_agent_reference_match",
] as const;

const removedMutablePreferenceChecks = [
  "slack_user_agent_preferences_agent_reference_match",
  "teams_user_agent_preferences_agent_reference_match",
  "telegram_user_agent_preferences_agent_reference_match",
  "feishu_user_agent_preferences_agent_reference_match",
] as const;

const retainedReferenceChecks = [
  ...immutableReferenceChecks,
  ...requiredMutableReferenceChecks,
] as const;

const immutableReferenceCheckSet: ReadonlySet<string> = new Set(
  immutableReferenceChecks,
);

const canonicalReferenceColumns = [
  ["agent_sessions", "agent_id"],
  ["chat_threads", "agent_id"],
  ["chat_thread_events", "agent_id"],
  ["chat_event_search_messages", "agent_id"],
  ["telegram_installations", "default_agent_id"],
  ["feishu_org_installations", "default_agent_id"],
  ["github_installations", "default_agent_id"],
  ["slack_user_agent_preferences", "selected_agent_id"],
  ["teams_user_agent_preferences", "selected_agent_id"],
  ["agentphone_user_agent_preferences", "selected_agent_id"],
  ["telegram_user_agent_preferences", "selected_agent_id"],
  ["feishu_user_agent_preferences", "selected_agent_id"],
] as const;

const canonicalAuthorityReferences = [
  [
    "org_metadata",
    "default_agent_id",
    "org_metadata_default_agent_id_agent_composes_id_fk",
  ],
  [
    "banking_agent_enablements",
    "agent_id",
    "banking_agent_enablements_agent_id_zero_agents_id_fk",
  ],
  ["thread_goals", "agent_id", "thread_goals_agent_id_zero_agents_id_fk"],
  ["user_connectors", "agent_id", "user_connectors_agent_id_zero_agents_id_fk"],
  [
    "user_custom_connectors",
    "agent_id",
    "user_custom_connectors_agent_id_zero_agents_id_fk",
  ],
  [
    "user_permission_grants",
    "agent_id",
    "user_permission_grants_agent_id_zero_agents_id_fk",
  ],
  [
    "zero_agent_drafts",
    "agent_id",
    "zero_agent_drafts_agent_id_zero_agents_id_fk",
  ],
  ["zero_workflows", "agent_id", "zero_workflows_agent_id_zero_agents_id_fk"],
] as const;

const canonicalReferenceForeignKeys = [
  ...canonicalReferenceColumns.filter(([table]) => {
    return !["chat_thread_events", "chat_event_search_messages"].includes(
      table,
    );
  }),
  ...canonicalAuthorityReferences.map(([table, column]) => {
    return [table, column] as const;
  }),
];

const canonicalReferenceIndexes = [
  ["agent_sessions", "idx_agent_sessions_user_agent"],
  ["chat_threads", "idx_chat_threads_user_agent_updated"],
  ["chat_threads", "idx_chat_threads_user_agent_pinned"],
  ["chat_threads", "idx_chat_threads_user_agent_last_message"],
  [
    "chat_event_search_messages",
    "chat_event_search_messages_user_org_agent_id_created_idx",
  ],
] as const;

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(connectionString: string, applicationName?: string) {
  const client = new Client({
    connectionString,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

function splitMigrationStatements(sql: string): readonly string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

function isPostgresErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function validateMigrationSql(sql: string): void {
  assert.ok(sql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(sql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/iu);
  assert.doesNotMatch(sql, /\b(?:backfill|CREATE\s+TRIGGER)\b/iu);
  assert.equal(
    sql.match(
      /ALTER COLUMN "(?:agent_compose_id|default_compose_id)" DROP NOT NULL/gu,
    )?.length,
    nullableLegacyColumns.length,
  );
  assert.equal(
    sql.match(/DROP CONSTRAINT IF EXISTS "[^"]+_agent_reference_match"/gu)
      ?.length,
    canonicalReferenceColumns.length,
  );
  assert.equal(
    sql.match(/NOT VALID;/gu)?.length,
    retainedReferenceChecks.length,
  );
  assert.equal(
    sql.match(/VALIDATE CONSTRAINT "[^"]+_agent_reference_match"/gu)?.length,
    retainedReferenceChecks.length,
  );
  for (const check of removedMutablePreferenceChecks) {
    assert.match(sql, new RegExp(`DROP CONSTRAINT IF EXISTS "${check}"`, "u"));
    assert.doesNotMatch(sql, new RegExp(`ADD CONSTRAINT "${check}"`, "u"));
    assert.doesNotMatch(sql, new RegExp(`VALIDATE CONSTRAINT "${check}"`, "u"));
  }
  assert.equal(
    sql.match(
      /CHECK \("default_agent_id" IS NOT NULL OR "default_compose_id" IS NOT NULL\) NOT VALID/gu,
    )?.length,
    requiredMutableReferenceChecks.length,
  );
  assert.match(sql, /SET lock_timeout = '1s'/u);
  assert.match(sql, /SET LOCAL lock_timeout = '1s'/u);
  assert.match(sql, /SET statement_timeout = '2h'/u);
  for (const [, , constraint] of canonicalAuthorityReferences) {
    assert.match(
      sql,
      new RegExp(`DROP CONSTRAINT IF EXISTS "${constraint}"`, "u"),
    );
  }
  assert.match(sql, /TG_OP = 'INSERT' AND NEW\."agent_id" IS NOT NULL/u);
  assert.match(
    sql,
    /TG_OP = 'INSERT' AND NEW\."default_agent_id" IS NOT NULL/u,
  );
  assert.match(
    sql,
    /TG_OP = 'INSERT' AND NEW\."selected_agent_id" IS NOT NULL/u,
  );
  const syncStart = sql.indexOf('FUNCTION "sync_agent_from_legacy_0966"');
  const bridgeStart = sql.indexOf(
    'FUNCTION "bridge_legacy_agent_to_agents_0966"',
  );
  assert.ok(syncStart >= 0 && bridgeStart > syncStart);
  const syncSql = sql.slice(syncStart, bridgeStart);
  assert.match(syncSql, /UPDATE "agents" AS "agent"/u);
  assert.doesNotMatch(syncSql, /INSERT INTO "agents"/u);
  assert.match(sql.slice(bridgeStart), /IF TG_OP = 'INSERT'/u);
  assert.match(sql.slice(bridgeStart), /INSERT INTO "agents"/u);
}

async function executeStatements(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await client.query(statement);
  }
}

async function seedLegacyAgent(
  client: Client,
  id: string,
  name: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
      VALUES ($1, 'stage7-owner', 'stage7-org', $2)
    `,
    [id, name],
  );
  await client.query(
    `
      INSERT INTO "zero_agents" (
        "id", "org_id", "owner", "name", "visibility"
      ) VALUES ($1, 'stage7-org', 'stage7-owner', $2, 'public')
    `,
    [id, name],
  );
}

async function seedUpgradeState(client: Client): Promise<void> {
  await seedLegacyAgent(client, agentId, "stage7-agent-a");
  await seedLegacyAgent(client, secondAgentId, "stage7-agent-b");
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
      VALUES ($1, 'compose-only-owner', 'compose-only-org', 'compose-only')
    `,
    [composeOnlyId],
  );
  await client.query(
    `
      INSERT INTO "chat_thread_events" (
        "id", "user_id", "org_id", "seq_id", "chat_thread_id", "kind",
        "agent_compose_id"
      ) VALUES (
        '00000000-0000-4000-8000-0000000972e0', 'protected-user',
        'compose-only-org', 1,
        '00000000-0000-4000-8000-0000000972e1', 'created', $1
      )
    `,
    [composeOnlyId],
  );
  await client.query(`
    INSERT INTO "slack_user_agent_preferences" ("user_id", "org_id")
    VALUES ('protected-null-user', 'protected-null-org')
  `);
}

async function assertSchemaContract(client: Client): Promise<void> {
  const nullable = await client.query<{ column: string }>(`
    SELECT "table_name" || '.' || "column_name" AS "column"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public' AND "is_nullable" = 'YES'
      AND ("table_name", "column_name") IN (
        ${nullableLegacyColumns
          .map(([table, column]) => {
            return `('${table}', '${column}')`;
          })
          .join(", ")}
      )
    ORDER BY 1
  `);
  assert.deepEqual(
    nullable.rows.map((row) => {
      return row.column;
    }),
    nullableLegacyColumns
      .map(([table, column]) => {
        return `${table}.${column}`;
      })
      .sort(),
  );

  const checks = await client.query<{
    definition: string;
    name: string;
    valid: boolean;
  }>(
    `
    SELECT "constraint"."conname" AS "name",
      pg_get_constraintdef("constraint"."oid") AS "definition",
      "constraint"."convalidated" AS "valid"
    FROM "pg_constraint" AS "constraint"
    WHERE "constraint"."conname" = ANY($1::text[])
    ORDER BY "constraint"."conname"
  `,
    [[...retainedReferenceChecks]],
  );
  assert.equal(checks.rows.length, retainedReferenceChecks.length);
  for (const check of checks.rows) {
    assert.equal(check.valid, true, `${check.name} must be validated`);
    if (immutableReferenceCheckSet.has(check.name)) {
      assert.match(
        check.definition,
        /(?:IS NOT DISTINCT FROM|NOT \([^()]+ IS DISTINCT FROM [^()]+\))/u,
      );
      assert.equal(check.definition.match(/IS NULL/gu)?.length, 2);
    } else {
      assert.doesNotMatch(check.definition, /IS NOT DISTINCT FROM/u);
      assert.equal(check.definition.match(/IS NOT NULL/gu)?.length, 2);
    }
  }

  const removedChecks = await client.query<{ count: number }>(
    `SELECT count(*)::int AS "count"
     FROM "pg_constraint"
     WHERE "conname" = ANY($1::text[])`,
    [[...removedMutablePreferenceChecks]],
  );
  assert.equal(removedChecks.rows[0]?.count, 0);

  for (const [table, column] of canonicalReferenceForeignKeys) {
    const foreignKeys = await client.query<{ count: number }>(
      `SELECT count(*)::int AS "count"
       FROM "pg_constraint" AS "constraint"
       WHERE "constraint"."contype" = 'f'
         AND "constraint"."conrelid" = $1::regclass
         AND "constraint"."confrelid" = 'public.agents'::regclass
         AND "constraint"."conkey" = ARRAY[
           (
             SELECT "attnum"::smallint
             FROM "pg_attribute"
             WHERE "attrelid" = $1::regclass AND "attname" = $2
           )
         ]::smallint[]`,
      [`public.${table}`, column],
    );
    assert.equal(
      foreignKeys.rows[0]?.count,
      1,
      `${table}.${column} must retain its canonical Agent foreign key`,
    );
  }

  const obsoleteCrossShapeForeignKeys = await client.query<{ count: number }>(
    `SELECT count(*)::int AS "count"
     FROM "pg_constraint"
     WHERE "conname" = ANY($1::text[])`,
    [
      canonicalAuthorityReferences.map(([, , constraint]) => {
        return constraint;
      }),
    ],
  );
  assert.equal(obsoleteCrossShapeForeignKeys.rows[0]?.count, 0);

  for (const [table, index] of canonicalReferenceIndexes) {
    const indexes = await client.query<{ count: number }>(
      `SELECT count(*)::int AS "count"
       FROM "pg_index" AS "index"
       INNER JOIN "pg_class" AS "relation"
         ON "relation"."oid" = "index"."indrelid"
       INNER JOIN "pg_class" AS "index_relation"
         ON "index_relation"."oid" = "index"."indexrelid"
       WHERE "relation"."oid" = $1::regclass
         AND "index_relation"."relname" = $2
         AND "index"."indisvalid"`,
      [`public.${table}`, index],
    );
    assert.equal(
      indexes.rows[0]?.count,
      1,
      `${table}.${index} must retain its canonical reference index`,
    );
  }
}

async function insertCanonicalReferences(client: Client): Promise<void> {
  const threadId = "00000000-0000-4000-8000-000000097210";
  await client.query(
    `INSERT INTO "agent_sessions" ("id", "user_id", "org_id", "agent_id")
     VALUES ('00000000-0000-4000-8000-000000097211', 'canonical-user', 'stage7-org', $1)`,
    [agentId],
  );
  await client.query(
    `INSERT INTO "chat_threads" ("id", "user_id", "agent_id")
     VALUES ($2, 'canonical-user', $1)`,
    [agentId, threadId],
  );
  await client.query(
    `INSERT INTO "chat_thread_events" (
       "id", "user_id", "org_id", "seq_id", "chat_thread_id", "kind", "agent_id"
     ) VALUES (
       '00000000-0000-4000-8000-000000097212', 'canonical-user',
       'stage7-org', 1, $2, 'created', $1
     )`,
    [agentId, threadId],
  );
  await client.query(
    `INSERT INTO "chat_event_search_messages" (
       "chat_thread_id", "seq_id", "user_id", "org_id", "agent_id",
       "role", "created_at", "text", "text_bigram"
     ) VALUES ($2, 1, 'canonical-user', 'stage7-org', $1, 'user', now(), 'hi', 'hi')`,
    [agentId, threadId],
  );
  await client.query(
    `INSERT INTO "telegram_installations" (
       "telegram_bot_id", "encrypted_bot_token", "webhook_secret",
       "default_agent_id", "owner_user_id", "org_id"
     ) VALUES ('stage7-bot', 'token', 'secret', $1, 'canonical-user', 'stage7-org')`,
    [agentId],
  );
  await client.query(
    `INSERT INTO "feishu_org_installations" (
       "org_id", "app_id", "encrypted_app_secret", "encrypted_verification_token",
       "encrypted_encrypt_key", "default_agent_id"
     ) VALUES ('stage7-org', 'stage7-app', 'secret', 'verify', 'encrypt', $1)`,
    [agentId],
  );
  await client.query(
    `INSERT INTO "github_installations" ("org_id", "default_agent_id")
     VALUES ('stage7-org', $1)`,
    [agentId],
  );
  for (const table of [
    "slack_user_agent_preferences",
    "teams_user_agent_preferences",
    "agentphone_user_agent_preferences",
    "telegram_user_agent_preferences",
    "feishu_user_agent_preferences",
  ]) {
    await client.query(
      `INSERT INTO "${table}" ("user_id", "org_id", "selected_agent_id")
       VALUES ('canonical-user', 'stage7-org', $1)`,
      [agentId],
    );
  }

  const referenceState = await client.query<{
    canonical: string;
    legacy: string | null;
  }>(`
    SELECT "agent_id"::text AS "canonical", "agent_compose_id"::text AS "legacy"
      FROM "agent_sessions" WHERE "user_id" = 'canonical-user'
    UNION ALL
    SELECT "agent_id"::text, "agent_compose_id"::text
      FROM "chat_threads" WHERE "user_id" = 'canonical-user'
    UNION ALL
    SELECT "agent_id"::text, "agent_compose_id"::text
      FROM "chat_thread_events" WHERE "user_id" = 'canonical-user'
    UNION ALL
    SELECT "agent_id"::text, "agent_compose_id"::text
      FROM "chat_event_search_messages" WHERE "user_id" = 'canonical-user'
    UNION ALL
    SELECT "default_agent_id"::text, "default_compose_id"::text
      FROM "telegram_installations" WHERE "telegram_bot_id" = 'stage7-bot'
    UNION ALL
    SELECT "default_agent_id"::text, "default_compose_id"::text
      FROM "feishu_org_installations" WHERE "app_id" = 'stage7-app'
    UNION ALL
    SELECT "default_agent_id"::text, "default_compose_id"::text
      FROM "github_installations" WHERE "org_id" = 'stage7-org'
    UNION ALL SELECT "selected_agent_id"::text, "selected_compose_id"::text FROM "slack_user_agent_preferences" WHERE "user_id" = 'canonical-user'
    UNION ALL SELECT "selected_agent_id"::text, "selected_compose_id"::text FROM "teams_user_agent_preferences" WHERE "user_id" = 'canonical-user'
    UNION ALL SELECT "selected_agent_id"::text, "selected_compose_id"::text FROM "agentphone_user_agent_preferences" WHERE "user_id" = 'canonical-user'
    UNION ALL SELECT "selected_agent_id"::text, "selected_compose_id"::text FROM "telegram_user_agent_preferences" WHERE "user_id" = 'canonical-user'
    UNION ALL SELECT "selected_agent_id"::text, "selected_compose_id"::text FROM "feishu_user_agent_preferences" WHERE "user_id" = 'canonical-user'
  `);
  assert.equal(referenceState.rows.length, canonicalReferenceColumns.length);
  assert.ok(
    referenceState.rows.every((row) => {
      return row.canonical === agentId && row.legacy === null;
    }),
  );

  await assert.rejects(
    client.query(
      `INSERT INTO "chat_threads" (
         "id", "user_id", "agent_compose_id", "agent_id"
       ) VALUES (
         '00000000-0000-4000-8000-000000097213',
         'immutable-conflict-user', $1, $2
       )`,
      [agentId, secondAgentId],
    ),
    (error: unknown) => {
      return isPostgresErrorCode(error, "23514");
    },
  );
}

async function assertCanonicalAgentOperations(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "agents" (
       "id", "org_id", "owner", "name", "visibility", "display_name",
       "description", "sound", "avatar_url", "model_provider_id",
       "selected_model", "prefer_personal_provider", "created_at", "updated_at"
     ) VALUES (
       $1, 'canonical-only-org', 'canonical-only-owner', 'canonical-only-agent',
       'private', 'Canonical only', NULL, NULL, NULL, NULL, NULL, false,
       '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z'
     )`,
    [canonicalOnlyAgentId],
  );
  let state = await client.query<{
    displayName: string | null;
    legacyComposes: number;
    legacyProducts: number;
  }>(
    `SELECT "agent"."display_name" AS "displayName",
       (SELECT count(*)::int FROM "agent_composes" WHERE "id" = $1) AS "legacyComposes",
       (SELECT count(*)::int FROM "zero_agents" WHERE "id" = $1) AS "legacyProducts"
     FROM "agents" AS "agent" WHERE "agent"."id" = $1`,
    [canonicalOnlyAgentId],
  );
  assert.deepEqual(state.rows, [
    {
      displayName: "Canonical only",
      legacyComposes: 0,
      legacyProducts: 0,
    },
  ]);

  await client.query("BEGIN");
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || $1::text, 0))`,
    [canonicalOnlyAgentId],
  );
  await client.query(
    `UPDATE "agents" SET "display_name" = 'Canonical updated' WHERE "id" = $1`,
    [canonicalOnlyAgentId],
  );
  await client.query("COMMIT");
  state = await client.query(
    `SELECT "display_name" AS "displayName",
       (SELECT count(*)::int FROM "agent_composes" WHERE "id" = $1) AS "legacyComposes",
       (SELECT count(*)::int FROM "zero_agents" WHERE "id" = $1) AS "legacyProducts"
     FROM "agents" WHERE "id" = $1`,
    [canonicalOnlyAgentId],
  );
  assert.equal(state.rows[0]?.displayName, "Canonical updated");
  assert.equal(state.rows[0]?.legacyComposes, 0);
  assert.equal(state.rows[0]?.legacyProducts, 0);

  await client.query(
    `INSERT INTO "org_metadata" ("org_id", "default_agent_id")
     VALUES ('canonical-only-org', $1)`,
    [canonicalOnlyAgentId],
  );
  const canonicalDefault = await client.query<{ agentId: string }>(
    `SELECT "default_agent_id"::text AS "agentId"
     FROM "org_metadata" WHERE "org_id" = 'canonical-only-org'`,
  );
  assert.equal(canonicalDefault.rows[0]?.agentId, canonicalOnlyAgentId);

  await client.query(
    `INSERT INTO "zero_workflows" (
       "org_id", "agent_id", "name", "owner_user_id", "created_by", "updated_by"
     ) VALUES (
       'canonical-only-org', $1, 'canonical-only-workflow',
       'canonical-only-owner', 'canonical-only-owner', 'canonical-only-owner'
     )`,
    [canonicalOnlyAgentId],
  );

  await client.query("BEGIN");
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || $1::text, 0))`,
    [canonicalOnlyAgentId],
  );
  await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [
    canonicalOnlyAgentId,
  ]);
  await client.query("COMMIT");
  const deleted = await client.query(`SELECT 1 FROM "agents" WHERE "id" = $1`, [
    canonicalOnlyAgentId,
  ]);
  assert.equal(deleted.rowCount, 0);
  const clearedDefault = await client.query<{ agentId: string | null }>(
    `SELECT "default_agent_id"::text AS "agentId"
     FROM "org_metadata" WHERE "org_id" = 'canonical-only-org'`,
  );
  assert.equal(clearedDefault.rows[0]?.agentId, null);
  assert.equal(
    (
      await client.query(
        `SELECT 1 FROM "zero_workflows" WHERE "agent_id" = $1`,
        [canonicalOnlyAgentId],
      )
    ).rowCount,
    0,
  );
}

async function assertReferenceBridgeOperations(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "telegram_installations" (
       "telegram_bot_id", "encrypted_bot_token", "webhook_secret",
       "default_compose_id", "owner_user_id", "org_id"
     ) VALUES (
       'stage6-legacy-bot', 'legacy-token', 'legacy-secret', $1,
       'legacy-owner', 'stage7-org'
     )`,
    [agentId],
  );
  let requiredDefault = await client.query<{
    canonical: string | null;
    legacy: string | null;
  }>(`
    SELECT "default_agent_id"::text AS "canonical",
      "default_compose_id"::text AS "legacy"
    FROM "telegram_installations"
    WHERE "telegram_bot_id" = 'stage6-legacy-bot'
  `);
  assert.deepEqual(requiredDefault.rows, [
    { canonical: agentId, legacy: agentId },
  ]);

  await client.query(
    `UPDATE "telegram_installations"
     SET "default_agent_id" = $1
     WHERE "telegram_bot_id" = 'stage6-legacy-bot'`,
    [secondAgentId],
  );
  requiredDefault = await client.query(`
    SELECT "default_agent_id"::text AS "canonical",
      "default_compose_id"::text AS "legacy"
    FROM "telegram_installations"
    WHERE "telegram_bot_id" = 'stage6-legacy-bot'
  `);
  assert.deepEqual(requiredDefault.rows, [
    { canonical: secondAgentId, legacy: agentId },
  ]);

  await client.query(
    `UPDATE "telegram_installations"
     SET "default_compose_id" = $1
     WHERE "telegram_bot_id" = 'stage6-legacy-bot'`,
    [secondAgentId],
  );
  requiredDefault = await client.query(`
    SELECT "default_agent_id"::text AS "canonical",
      "default_compose_id"::text AS "legacy"
    FROM "telegram_installations"
    WHERE "telegram_bot_id" = 'stage6-legacy-bot'
  `);
  assert.deepEqual(requiredDefault.rows, [
    { canonical: secondAgentId, legacy: secondAgentId },
  ]);

  await assert.rejects(
    client.query(
      `INSERT INTO "telegram_installations" (
         "telegram_bot_id", "encrypted_bot_token", "webhook_secret",
         "owner_user_id", "org_id"
       ) VALUES (
         'missing-default-bot', 'token', 'secret', 'owner', 'stage7-org'
       )`,
    ),
    (error: unknown) => {
      return isPostgresErrorCode(error, "23514");
    },
  );
  await assert.rejects(
    client.query(
      `INSERT INTO "telegram_installations" (
         "telegram_bot_id", "encrypted_bot_token", "webhook_secret",
         "default_agent_id", "owner_user_id", "org_id"
       ) VALUES (
         'invalid-default-bot', 'token', 'secret',
         '00000000-0000-4000-8000-0000000972de', 'owner', 'stage7-org'
       )`,
    ),
    (error: unknown) => {
      return isPostgresErrorCode(error, "23503");
    },
  );

  await client.query(
    `INSERT INTO "slack_user_agent_preferences" (
       "user_id", "org_id", "selected_compose_id"
     ) VALUES ('legacy-user', 'stage7-org', $1)`,
    [agentId],
  );
  let row = await client.query<{
    canonical: string | null;
    legacy: string | null;
  }>(`
    SELECT "selected_agent_id"::text AS "canonical",
      "selected_compose_id"::text AS "legacy"
    FROM "slack_user_agent_preferences" WHERE "user_id" = 'legacy-user'
  `);
  assert.deepEqual(row.rows, [{ canonical: agentId, legacy: agentId }]);

  await client.query(
    `UPDATE "slack_user_agent_preferences"
     SET "selected_agent_id" = $1, "updated_at" = now()
     WHERE "user_id" = 'legacy-user'`,
    [secondAgentId],
  );
  row = await client.query(`
    SELECT "selected_agent_id"::text AS "canonical",
      "selected_compose_id"::text AS "legacy"
    FROM "slack_user_agent_preferences" WHERE "user_id" = 'legacy-user'
  `);
  assert.deepEqual(row.rows, [{ canonical: secondAgentId, legacy: agentId }]);

  await client.query(`
    UPDATE "slack_user_agent_preferences"
    SET "selected_compose_id" = NULL
    WHERE "user_id" = 'legacy-user'
  `);
  row = await client.query(`
    SELECT "selected_agent_id"::text AS "canonical",
      "selected_compose_id"::text AS "legacy"
    FROM "slack_user_agent_preferences" WHERE "user_id" = 'legacy-user'
  `);
  assert.deepEqual(row.rows, [{ canonical: null, legacy: null }]);

  await client.query(
    `UPDATE "slack_user_agent_preferences"
     SET "selected_agent_id" = $1, "updated_at" = now()
     WHERE "user_id" = 'legacy-user'`,
    [secondAgentId],
  );
  row = await client.query(`
    SELECT "selected_agent_id"::text AS "canonical",
      "selected_compose_id"::text AS "legacy"
    FROM "slack_user_agent_preferences" WHERE "user_id" = 'legacy-user'
  `);
  assert.deepEqual(row.rows, [{ canonical: secondAgentId, legacy: null }]);

  await client.query(
    `DELETE FROM "slack_user_agent_preferences" WHERE "user_id" = 'legacy-user'`,
  );
  assert.equal(
    (
      await client.query(
        `SELECT 1 FROM "slack_user_agent_preferences" WHERE "user_id" = 'legacy-user'`,
      )
    ).rowCount,
    0,
  );
}

async function assertIdentityBridgeOperations(client: Client): Promise<void> {
  const updateOnlyId = "00000000-0000-4000-8000-000000097220";
  await client.query(
    `INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
     VALUES ($1, 'bridge-owner', 'bridge-org', 'bridge-agent')`,
    [updateOnlyId],
  );
  let row = await client.query(`SELECT 1 FROM "agents" WHERE "id" = $1`, [
    updateOnlyId,
  ]);
  assert.equal(row.rowCount, 0);
  await client.query(
    `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
     VALUES ($1, 'bridge-org', 'bridge-owner', 'bridge-agent')`,
    [updateOnlyId],
  );
  row = await client.query(`SELECT 1 FROM "agents" WHERE "id" = $1`, [
    updateOnlyId,
  ]);
  assert.equal(row.rowCount, 1);

  await client.query("BEGIN");
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || $1::text, 0))`,
    [updateOnlyId],
  );
  await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [updateOnlyId]);
  await client.query("COMMIT");
  await client.query(
    `UPDATE "zero_agents" SET "display_name" = 'must-not-resurrect' WHERE "id" = $1`,
    [updateOnlyId],
  );
  row = await client.query(`SELECT 1 FROM "agents" WHERE "id" = $1`, [
    updateOnlyId,
  ]);
  assert.equal(row.rowCount, 0);
  await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    updateOnlyId,
  ]);

  const deleteId = "00000000-0000-4000-8000-000000097221";
  await seedLegacyAgent(client, deleteId, "legacy-delete-agent");
  await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    deleteId,
  ]);
  row = await client.query(`SELECT 1 FROM "agents" WHERE "id" = $1`, [
    deleteId,
  ]);
  assert.equal(row.rowCount, 0);
}

async function waitForBlock(
  observer: Client,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const state = await observer.query<{ blocked: boolean }>(
      `
      SELECT cardinality(pg_blocking_pids("pid")) > 0 AS "blocked"
      FROM "pg_stat_activity" WHERE "application_name" = $1
    `,
      [applicationName],
    );
    if (state.rows[0]?.blocked) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  assert.fail(`backend ${applicationName} did not reach a blocked state`);
}

async function assertIdentityBridgeRaces(
  observer: Client,
  connectionString: string,
): Promise<void> {
  const createRaceId = "00000000-0000-4000-8000-000000097229";
  const canonicalCreate = await connect(
    connectionString,
    "stage7-canonical-create",
  );
  const legacyCreate = await connect(connectionString, "stage7-legacy-create");
  try {
    await canonicalCreate.query("BEGIN");
    await canonicalCreate.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || $1::text, 0))`,
      [createRaceId],
    );
    await canonicalCreate.query(
      `INSERT INTO "agents" (
         "id", "org_id", "owner", "name", "display_name"
       ) VALUES ($1, 'create-race-org', 'canonical-owner', 'canonical-create', 'canonical-first')`,
      [createRaceId],
    );

    await legacyCreate.query("BEGIN");
    const composeInsert = legacyCreate.query(
      `INSERT INTO "agent_composes" ("id", "user_id", "org_id", "name")
       VALUES ($1, 'legacy-owner', 'create-race-org', 'legacy-create')`,
      [createRaceId],
    );
    await waitForBlock(observer, "stage7-legacy-create");
    await canonicalCreate.query("COMMIT");
    await composeInsert;
    await legacyCreate.query(
      `INSERT INTO "zero_agents" (
         "id", "org_id", "owner", "name", "display_name"
       ) VALUES ($1, 'create-race-org', 'legacy-owner', 'legacy-create', 'legacy-last')`,
      [createRaceId],
    );
    await legacyCreate.query("COMMIT");
  } finally {
    await canonicalCreate.query("ROLLBACK");
    await legacyCreate.query("ROLLBACK");
    await canonicalCreate.end();
    await legacyCreate.end();
  }
  const created = await observer.query<{
    displayName: string | null;
    name: string;
    owner: string;
  }>(
    `SELECT "display_name" AS "displayName", "name", "owner"
     FROM "agents" WHERE "id" = $1`,
    [createRaceId],
  );
  assert.deepEqual(created.rows, [
    {
      displayName: "legacy-last",
      name: "legacy-create",
      owner: "legacy-owner",
    },
  ]);
  await observer.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    createRaceId,
  ]);

  const deleteRaceId = "00000000-0000-4000-8000-000000097230";
  await seedLegacyAgent(observer, deleteRaceId, "delete-race-agent");
  const canonicalDelete = await connect(
    connectionString,
    "stage7-canonical-delete",
  );
  const legacyUpdate = await connect(connectionString, "stage7-legacy-update");
  try {
    await canonicalDelete.query("BEGIN");
    await canonicalDelete.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || $1::text, 0))`,
      [deleteRaceId],
    );
    await canonicalDelete.query(`DELETE FROM "agents" WHERE "id" = $1`, [
      deleteRaceId,
    ]);
    await legacyUpdate.query("BEGIN");
    const update = legacyUpdate.query(
      `UPDATE "zero_agents" SET "display_name" = 'outgoing-update' WHERE "id" = $1`,
      [deleteRaceId],
    );
    await waitForBlock(observer, "stage7-legacy-update");
    await canonicalDelete.query("COMMIT");
    await update;
    await legacyUpdate.query("COMMIT");
  } finally {
    await canonicalDelete.query("ROLLBACK");
    await legacyUpdate.query("ROLLBACK");
    await canonicalDelete.end();
    await legacyUpdate.end();
  }
  const deleted = await observer.query(
    `SELECT 1 FROM "agents" WHERE "id" = $1`,
    [deleteRaceId],
  );
  assert.equal(deleted.rowCount, 0);
  await observer.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
    deleteRaceId,
  ]);

  const updateRaceId = "00000000-0000-4000-8000-000000097231";
  await seedLegacyAgent(observer, updateRaceId, "update-race-agent");
  const legacyWriter = await connect(
    connectionString,
    "stage7-legacy-lock-owner",
  );
  const canonicalWriter = await connect(
    connectionString,
    "stage7-canonical-update",
  );
  try {
    await legacyWriter.query("BEGIN");
    await legacyWriter.query(
      `UPDATE "zero_agents" SET "display_name" = 'legacy-wins-first' WHERE "id" = $1`,
      [updateRaceId],
    );
    await canonicalWriter.query("BEGIN");
    const lock = canonicalWriter.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || $1::text, 0))`,
      [updateRaceId],
    );
    await waitForBlock(observer, "stage7-canonical-update");
    await legacyWriter.query("COMMIT");
    await lock;
    await canonicalWriter.query(
      `UPDATE "agents" SET "display_name" = 'canonical-wins-last' WHERE "id" = $1`,
      [updateRaceId],
    );
    await canonicalWriter.query("COMMIT");
  } finally {
    await legacyWriter.query("ROLLBACK");
    await canonicalWriter.query("ROLLBACK");
    await legacyWriter.end();
    await canonicalWriter.end();
  }
  const updated = await observer.query<{ displayName: string | null }>(
    `SELECT "display_name" AS "displayName" FROM "agents" WHERE "id" = $1`,
    [updateRaceId],
  );
  assert.equal(updated.rows[0]?.displayName, "canonical-wins-last");
}

async function assertProtectedHistory(client: Client): Promise<void> {
  const compose = await client.query(
    `SELECT 1 FROM "agent_composes" WHERE "id" = $1`,
    [composeOnlyId],
  );
  assert.equal(compose.rowCount, 1);
  const event = await client.query<{
    canonical: string | null;
    legacy: string;
  }>(`
    SELECT "agent_id"::text AS "canonical", "agent_compose_id"::text AS "legacy"
    FROM "chat_thread_events"
    WHERE "id" = '00000000-0000-4000-8000-0000000972e0'
  `);
  assert.deepEqual(event.rows, [{ canonical: null, legacy: composeOnlyId }]);
  const nullablePreference = await client.query<{
    canonical: string | null;
    legacy: string | null;
  }>(`
    SELECT "selected_agent_id"::text AS "canonical",
      "selected_compose_id"::text AS "legacy"
    FROM "slack_user_agent_preferences"
    WHERE "user_id" = 'protected-null-user'
  `);
  assert.deepEqual(nullablePreference.rows, [
    { canonical: null, legacy: null },
  ]);
  await assert.rejects(
    client.query(`
      UPDATE "chat_thread_events" SET "title" = 'forbidden'
      WHERE "id" = '00000000-0000-4000-8000-0000000972e0'
    `),
    /append-only/u,
  );
}

async function resetDatabase(
  adminUrl: string,
  database: string,
): Promise<void> {
  const admin = await connect(adminUrl);
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();
}

export async function validateCanonicalAgentWritePlaneMigration(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${migration}.sql`),
    "utf8",
  );
  validateMigrationSql(migrationSql);
  const statements = splitMigrationStatements(migrationSql);
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = databaseUrlFor(databaseUrl, "postgres");
  const upgradeUrl = databaseUrlFor(databaseUrl, upgradeDatabase);
  const freshUrl = databaseUrlFor(databaseUrl, freshDatabase);

  await resetDatabase(adminUrl, upgradeDatabase);
  await resetDatabase(adminUrl, freshDatabase);
  const upgrade = await connect(upgradeUrl, "stage7-observer");
  const fresh = await connect(freshUrl);
  try {
    await applyMigrationsFromDirectoryUpToTag(
      upgrade,
      migrationsDirectory,
      previousMigration,
    );
    await seedUpgradeState(upgrade);
    await applyMigrationsFromDirectoryUpToTag(
      upgrade,
      migrationsDirectory,
      migration,
    );
    // A deployment retry must be harmless after every statement committed.
    await executeStatements(upgrade, statements);
    await assertSchemaContract(upgrade);
    await assertProtectedHistory(upgrade);
    await assertCanonicalAgentOperations(upgrade);
    await insertCanonicalReferences(upgrade);
    await assertReferenceBridgeOperations(upgrade);
    await assertIdentityBridgeOperations(upgrade);
    await assertIdentityBridgeRaces(upgrade, upgradeUrl);

    await applyMigrationsFromDirectoryUpToTag(
      fresh,
      migrationsDirectory,
      migration,
    );
    await assertSchemaContract(fresh);
  } finally {
    await upgrade.end();
    await fresh.end();
    const admin = await connect(adminUrl);
    await admin.query(
      `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
    );
    await admin.query(
      `DROP DATABASE IF EXISTS "${freshDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }

  console.log("canonical Agent write-plane migration passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateCanonicalAgentWritePlaneMigration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
