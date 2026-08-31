import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration =
  "1033_org_metadata_acquisition_first_party_source_expand";
export const CHAT_SEARCH_DELETE_COMPATIBILITY_MIGRATION =
  "1034_chat_search_delete_compatibility";
export const CHAT_SEARCH_FOREIGN_KEY_CONTRACTION_MIGRATION =
  "1035_noisy_rockslide";
const testDatabaseName = "migration_chat_search_delete_compatibility_30453";

export const CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_TRIGGER = {
  definition:
    "CREATE TRIGGER chat_threads_delete_search_projection_1034 AFTER DELETE ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION delete_chat_event_search_projection_1034()",
  schemaName: "public",
  tableName: "chat_threads",
  triggerName: "chat_threads_delete_search_projection_1034",
} as const;

export const CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_FUNCTION = {
  bodyHash: "e1fbe1ea49b41a5c7326f63a954c7aff",
  functionName: "delete_chat_event_search_projection_1034",
  identityArguments: "",
  kind: "f",
  schemaName: "public",
} as const;

const fixture = {
  agentId: "00000000-0000-4000-8000-000000030453",
  orgId: "org-chat-search-delete-compatibility-30453",
  threadId: "00000000-0000-4000-8000-000000304530",
  userId: "user-chat-search-delete-compatibility-30453",
} as const;

function createDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function executeOnAdminDatabase(
  baseUrl: string,
  query: string,
): Promise<void> {
  const client = new Client({
    connectionString: createDatabaseUrl(baseUrl, "postgres"),
  });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

async function createDatabase(baseUrl: string): Promise<string> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`,
  );
  await executeOnAdminDatabase(
    baseUrl,
    `CREATE DATABASE "${testDatabaseName}"`,
  );
  return createDatabaseUrl(baseUrl, testDatabaseName);
}

async function dropDatabase(baseUrl: string): Promise<void> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`,
  );
}

function migrationStatements(sql: string): readonly string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim().replace(/\s+/gu, " ");
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

async function validateMigrationSql(): Promise<void> {
  const compatibilitySql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${CHAT_SEARCH_DELETE_COMPATIBILITY_MIGRATION}.sql`,
    ),
    "utf8",
  );
  const compatibilityStatements = migrationStatements(compatibilitySql);
  assert.equal(compatibilityStatements.length, 2);
  assert.match(
    compatibilityStatements[0] ?? "",
    /CREATE FUNCTION "delete_chat_event_search_projection_1034"\(\).*DELETE FROM "public"\."chat_event_search_messages" WHERE "chat_thread_id" = OLD\."id";.*DELETE FROM "public"\."chat_event_search_message_watermarks" WHERE "chat_thread_id" = OLD\."id";.*RETURN OLD;/u,
  );
  assert.match(
    compatibilityStatements[1] ?? "",
    /CREATE TRIGGER "chat_threads_delete_search_projection_1034" AFTER DELETE ON "public"\."chat_threads" FOR EACH ROW EXECUTE FUNCTION "public"\."delete_chat_event_search_projection_1034"\(\);$/u,
  );

  const contractionSql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${CHAT_SEARCH_FOREIGN_KEY_CONTRACTION_MIGRATION}.sql`,
    ),
    "utf8",
  );
  assert.deepEqual(migrationStatements(contractionSql), [
    'ALTER TABLE "chat_event_search_message_watermarks" DROP CONSTRAINT "chat_event_search_message_watermarks_chat_thread_id_chat_threads_id_fk";',
    'ALTER TABLE "chat_event_search_messages" DROP CONSTRAINT "chat_event_search_messages_chat_thread_id_chat_threads_id_fk";',
  ]);
}

async function validateMigratedCatalog(client: Client): Promise<void> {
  const foreignKeys = await client.query<{ constraintName: string }>(`
    SELECT "constraint_row"."conname" AS "constraintName"
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    WHERE "constraint_row"."contype" = 'f'
      AND "constraint_row"."confrelid" = 'public.chat_threads'::regclass
      AND "constraint_row"."conrelid" IN (
        'public.chat_event_search_messages'::regclass,
        'public.chat_event_search_message_watermarks'::regclass
      )
    ORDER BY "constraint_row"."conname"
  `);
  assert.deepEqual(foreignKeys.rows, []);

  await client.query(`SET search_path TO public, pg_catalog`);
  const triggers = await client.query<{
    definition: string;
    enabled: string;
    schemaName: string;
    tableName: string;
    triggerName: string;
  }>(`
    SELECT
      pg_catalog.pg_get_triggerdef("trigger_row"."oid") AS "definition",
      "trigger_row"."tgenabled"::text AS "enabled",
      "namespace_row"."nspname" AS "schemaName",
      "relation_row"."relname" AS "tableName",
      "trigger_row"."tgname" AS "triggerName"
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
      ON "relation_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "relation_row"."relnamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "trigger_row"."tgname" =
        'chat_threads_delete_search_projection_1034'
      AND NOT "trigger_row"."tgisinternal"
  `);
  assert.deepEqual(triggers.rows, [
    {
      ...CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_TRIGGER,
      enabled: "O",
    },
  ]);

  const functions = await client.query<{
    bodyHash: string;
    functionName: string;
    identityArguments: string;
    kind: string;
    schemaName: string;
  }>(`
    SELECT
      pg_catalog.md5("function_row"."prosrc") AS "bodyHash",
      "function_row"."proname" AS "functionName",
      pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
        AS "identityArguments",
      "function_row"."prokind"::text AS "kind",
      "namespace_row"."nspname" AS "schemaName"
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'delete_chat_event_search_projection_1034'
  `);
  assert.deepEqual(functions.rows, [
    CHAT_SEARCH_DELETE_COMPATIBILITY_PERMANENT_FUNCTION,
  ]);
}

async function seedOldApiFixture(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, 'Chat Search Compatibility Agent')
    `,
    [fixture.agentId, fixture.orgId, fixture.userId],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" ("id", "user_id", "agent_id", "title")
      VALUES ($1, $2, $3, 'Chat Search Compatibility Thread')
    `,
    [fixture.threadId, fixture.userId, fixture.agentId],
  );
  await client.query(
    `
      INSERT INTO "chat_event_search_messages" (
        "chat_thread_id",
        "seq_id",
        "user_id",
        "org_id",
        "agent_id",
        "role",
        "created_at",
        "text",
        "text_bigram"
      ) VALUES ($1, 1, $2, $3, $4, 'user', $5, 'rollback bridge', 'rollback bridge')
    `,
    [
      fixture.threadId,
      fixture.userId,
      fixture.orgId,
      fixture.agentId,
      "2030-01-02T03:04:05.000Z",
    ],
  );
  await client.query(
    `
      INSERT INTO "chat_event_search_message_watermarks" (
        "chat_thread_id", "indexed_seq_id"
      ) VALUES ($1, 1)
    `,
    [fixture.threadId],
  );
}

async function readWithOldApiQuery(client: Client): Promise<readonly object[]> {
  const result = await client.query(
    `
      WITH "chat_search_indexed_matches" AS (
        SELECT
          "message"."chat_thread_id",
          "message"."seq_id",
          "message"."agent_id",
          "message"."created_at",
          "message"."text"
        FROM "chat_event_search_messages" AS "message"
        WHERE "message"."user_id" = $1
          AND "message"."org_id" = $2
          AND "message"."tsv" @@ to_tsquery('simple', 'rollback')
        ORDER BY "message"."created_at" DESC
        LIMIT 21
      )
      SELECT
        "match"."chat_thread_id",
        "match"."seq_id",
        "match"."text",
        "agent"."name" AS "agent_name"
      FROM "chat_search_indexed_matches" AS "match"
      INNER JOIN "agents" AS "agent" ON "match"."agent_id" = "agent"."id"
      ORDER BY "match"."created_at" DESC
    `,
    [fixture.userId, fixture.orgId],
  );
  return result.rows as readonly object[];
}

async function validateOldApiAgainstMigratedSchema(
  client: Client,
): Promise<void> {
  assert.equal((await readWithOldApiQuery(client)).length, 1);

  await client.query("BEGIN");
  try {
    // This is the pre-#30453 API's parent-only delete statement. The migrated
    // schema must preserve its cleanup behavior after the two FKs are gone.
    const deleted = await client.query<{ id: string }>(
      `DELETE FROM "chat_threads" WHERE "id" = $1 RETURNING "id"`,
      [fixture.threadId],
    );
    assert.deepEqual(deleted.rows, [{ id: fixture.threadId }]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const projectionRows = await client.query<{ count: number }>(
    `
      SELECT (
        (SELECT count(*) FROM "chat_event_search_messages"
          WHERE "chat_thread_id" = $1)
        +
        (SELECT count(*) FROM "chat_event_search_message_watermarks"
          WHERE "chat_thread_id" = $1)
      )::integer AS "count"
    `,
    [fixture.threadId],
  );
  assert.deepEqual(projectionRows.rows, [{ count: 0 }]);
  assert.deepEqual(await readWithOldApiQuery(client), []);
}

export async function validateChatSearchDeleteCompatibility(
  baseDbUrl: string,
): Promise<void> {
  console.log("=== Validate chat-search delete compatibility ===\n");
  await validateMigrationSql();

  const databaseUrl = await createDatabase(baseDbUrl);
  try {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        previousMigration,
      );
      await seedOldApiFixture(client);
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        CHAT_SEARCH_DELETE_COMPATIBILITY_MIGRATION,
      );
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        CHAT_SEARCH_FOREIGN_KEY_CONTRACTION_MIGRATION,
      );
      await validateMigratedCatalog(client);
      await validateOldApiAgainstMigratedSchema(client);
      console.log(
        "   ✅ old API delete cleans both projections after FK contraction\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(baseDbUrl);
  }
}
