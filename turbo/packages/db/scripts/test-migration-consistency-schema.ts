#!/usr/bin/env tsx
/**
 * Migration Consistency Test - Schema Comparison
 *
 * This script verifies that all migration files match the schema definitions
 * by comparing the final database state using normalized comparison.
 *
 * Steps:
 * 1. Create test database and run existing migrations
 * 2. Create test database, regenerate migrations from schema and run them
 * 3. Compare schemas using normalized comparison (ignores benign differences)
 *
 * Note: Uses pg library for all database operations (no pg_dump/psql required)
 *
 * IMPORTANT: Migration Best Practices
 * ===================================
 *
 * ❌ NEVER manually write migration files!
 * ❌ NEVER edit existing migration files!
 * ❌ NEVER manually create snapshot files!
 *
 * ✅ ALWAYS use `pnpm -F @vm0/db db:generate` to auto-generate migrations
 * ✅ ALWAYS let Drizzle Kit manage the snapshot system
 * ✅ ALWAYS test with `pnpm test:migration-consistency` before merging
 *
 * Manual migrations break the snapshot chain and cause this test to fail.
 * If this test fails, follow the fix instructions in the error message.
 */

import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { chatEvents } from "../src/schema/chat-event";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(dirname, "..");
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, "src/migrations");
const BACKUP_DIR = path.join(dirname, "../.migrations-backup");
const RESTORE_DIR = path.join(dirname, "../.migrations-restore");

// Parse DATABASE_URL to get connection details
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}
const dbUrl = new URL(DATABASE_URL);
const DB_HOST = dbUrl.hostname;
const DB_PORT = dbUrl.port;
const DB_USER = dbUrl.username;
const DB_PASSWORD = dbUrl.password;

function createTestDbUrl(dbName: string): string {
  const auth = DB_PASSWORD ? `${DB_USER}:${DB_PASSWORD}` : DB_USER;
  return `postgresql://${auth}@${DB_HOST}:${DB_PORT}/${dbName}`;
}

function execCommand(
  cmd: string,
  options?: { env?: Record<string, string>; cwd?: string },
): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });
}

async function executeOnPostgres(sql: string): Promise<void> {
  const client = new Client({
    host: DB_HOST,
    port: parseInt(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: "postgres", // Connect to default postgres database
  });

  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(dbName: string): Promise<void> {
  console.log(`📦 Creating database: ${dbName}`);
  try {
    await executeOnPostgres(`CREATE DATABASE ${dbName}`);
  } catch {
    // Database might already exist, try to drop and recreate
    console.log(`   Database exists, dropping and recreating...`);
    await executeOnPostgres(`DROP DATABASE IF EXISTS ${dbName}`);
    await executeOnPostgres(`CREATE DATABASE ${dbName}`);
  }
}

async function dropDatabase(dbName: string): Promise<void> {
  console.log(`🗑️  Dropping database: ${dbName}`);
  try {
    await executeOnPostgres(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch {
    console.warn(`   Warning: Failed to drop database ${dbName}`);
  }
}

async function runMigrations(dbUrl: string): Promise<void> {
  console.log(`🔨 Running migrations...`);
  execCommand(`tsx ${path.join(dirname, "migrate.ts")}`, {
    env: { DATABASE_URL: dbUrl },
    cwd: PACKAGE_DIR,
  });
}

async function resetDatabase(dbUrl: string): Promise<void> {
  console.log(`♻️  Resetting database...`);
  execCommand(`tsx ${path.join(dirname, "reset-db.ts")}`, {
    env: { DATABASE_URL: dbUrl },
    cwd: PACKAGE_DIR,
  });
}

async function applyMigrationsUpToTag(
  client: Client,
  upToTag: string,
): Promise<void> {
  // Create drizzle migrations table
  await client.query(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // Read journal to get migration order
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;
  const upToEntry = entries.find((entry) => {
    return entry.tag === upToTag;
  });
  if (!upToEntry) {
    throw new Error(
      `Migration tag "${upToTag}" is absent from meta/_journal.json because that migration has been squashed. This transition validator is expired and should be deleted.`,
    );
  }

  // Apply migrations up to the specified tag
  for (const entry of entries) {
    if (entry.idx > upToEntry.idx) break;

    const sqlFile = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const sql = await fs.readFile(sqlFile, "utf-8");

    // Check if already applied
    const result = await client.query(
      `SELECT 1 FROM "__drizzle_migrations" WHERE hash = $1`,
      [entry.tag],
    );

    if (result.rows.length === 0) {
      if (sql.includes(NON_TRANSACTIONAL_MIGRATION_MARKER)) {
        const statements = sql
          .split("--> statement-breakpoint")
          .map((statement) => {
            return statement.trim();
          })
          .filter((statement) => {
            return statement.length > 0;
          });
        for (const statement of statements) {
          await client.query(statement);
        }
      } else {
        await client.query(sql);
      }
      // Record in migrations table
      await client.query(
        `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [entry.tag, Date.now()],
      );
    }
  }
}

async function runMigrationsUpToTag(
  dbUrl: string,
  upToTag: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await applyMigrationsUpToTag(client, upToTag);
  } finally {
    await client.end();
  }
}

async function validateExpandedBrowserSchema(dbUrl: string): Promise<void> {
  console.log("=== Phase 2.4: Validate expanded browser schema ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const tables = await client.query<{
      browserProfiles: string | null;
      tabSnapshots: string | null;
    }>(
      `
        SELECT
          to_regclass('public.browser_profiles')::text AS "browserProfiles",
          to_regclass('public.browser_session_tab_snapshots')::text
            AS "tabSnapshots"
      `,
    );
    // The retired browser table stays until the pre-cleanup API drains; the
    // follow-up contraction release drops it together with its declaration.
    assert.deepEqual(tables.rows, [
      {
        browserProfiles: "browser_profiles",
        tabSnapshots: "browser_session_tab_snapshots",
      },
    ]);

    const retiredColumns = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND ("table_name", "column_name") IN (
            ('browser_sessions', 'id'),
            ('browser_sessions', 'browser_profile_id'),
            ('browser_session_instances', 'browser_session_id'),
            ('browser_thread_profiles', 'id')
          )
      `,
    );
    // Same two-release contract: the declarations and physical columns are
    // dropped together only after this release has drained.
    assert.deepEqual(retiredColumns.rows, [{ count: 4 }]);

    const primaryKeys = await client.query<{
      columnName: string;
      tableName: string;
    }>(
      `
        SELECT
          "tc"."table_name" AS "tableName",
          "kcu"."column_name" AS "columnName"
        FROM "information_schema"."table_constraints" AS "tc"
        INNER JOIN "information_schema"."key_column_usage" AS "kcu"
          ON "tc"."constraint_name" = "kcu"."constraint_name"
          AND "tc"."table_schema" = "kcu"."table_schema"
        WHERE "tc"."table_schema" = 'public'
          AND "tc"."constraint_type" = 'PRIMARY KEY'
          AND "tc"."table_name" IN (
            'browser_sessions',
            'browser_thread_profiles'
          )
        ORDER BY "tc"."table_name", "kcu"."ordinal_position"
      `,
    );
    // Current code keys every lookup by chat_thread_id, but the physical
    // primary key stays on the retired identity column for this release.
    assert.deepEqual(primaryKeys.rows, [
      { tableName: "browser_sessions", columnName: "id" },
      { tableName: "browser_thread_profiles", columnName: "id" },
    ]);

    const lifecycleConstraint = await client.query<{ definition: string }>(
      `
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `,
    );
    assert.equal(lifecycleConstraint.rows.length, 1);
    const lifecycleDefinition = lifecycleConstraint.rows[0]?.definition ?? "";
    // Only the canonical lifecycle values remain after the old API drain.
    assert.match(lifecycleDefinition, /browser\.open/u);
    assert.match(lifecycleDefinition, /browser\.close/u);
    assert.doesNotMatch(lifecycleDefinition, /browser\.started/u);
    assert.doesNotMatch(lifecycleDefinition, /browser\.stopped/u);
    assert.match(lifecycleDefinition, /goal\.open/u);
    assert.match(lifecycleDefinition, /goal\.close/u);
    assert.doesNotMatch(lifecycleDefinition, /goal\.changed/u);
    console.log(
      "   ✅ retired browser tables and identity columns still exist",
    );
    console.log(
      "   ✅ browser lifecycle and goal event constraints are canonical\n",
    );
  } finally {
    await client.end();
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectAppendOnlyUpdateRejected(
  client: Client,
  args: {
    readonly tableName: "chat_events" | "chat_messages" | "chat_thread_events";
    readonly query: string;
    readonly rowId: string;
  },
): Promise<void> {
  try {
    await client.query(args.query, [args.rowId]);
  } catch (error) {
    const expectedMessage = `${args.tableName} is append-only; UPDATE is not allowed`;
    if (
      databaseErrorCode(error) === "P0001" &&
      error instanceof Error &&
      error.message.includes(expectedMessage)
    ) {
      return;
    }
    throw error;
  }

  throw new Error(`${args.tableName} accepted an UPDATE`);
}

async function assertChatEventsAppendOnlyProtection(
  client: Client,
  rowId: string,
): Promise<void> {
  const triggers = await client.query<{
    enabled: string;
    triggerName: string;
  }>(`
    SELECT
      "tgname" AS "triggerName",
      "tgenabled"::text AS "enabled"
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND NOT "tgisinternal"
  `);
  assert.deepEqual(triggers.rows, [
    { enabled: "O", triggerName: "chat_events_reject_update" },
  ]);
  await expectAppendOnlyUpdateRejected(client, {
    tableName: "chat_events",
    query: `UPDATE "chat_events" SET "content" = 'mutated' WHERE "id" = $1`,
    rowId,
  });
}

async function validateCanonicalChatMessageStorage(
  client: Client,
  threadId: string,
): Promise<string> {
  const sequenceReservation = await client.query<{ lastSeqId: string }>(
    `
      UPDATE "chat_threads"
      SET "last_chat_event_seq_id" = "last_chat_event_seq_id" + 2
      WHERE "id" = $1
      RETURNING "last_chat_event_seq_id" AS "lastSeqId"
    `,
    [threadId],
  );
  const lastSeqId = Number(sequenceReservation.rows[0]?.lastSeqId);
  assert.ok(Number.isSafeInteger(lastSeqId));
  const firstSeqId = lastSeqId - 1;
  const userMessage = {
    version: 1,
    parts: [{ type: "text", text: "canonical API migration test" }],
  };
  const message = await client.query<{
    content: string | null;
    contextType: string | null;
    id: string;
    seqId: string;
    userMessage: unknown;
  }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "content",
        "context_type",
        "event_type",
        "seq_id",
        "user_message"
      )
      VALUES (
        $1,
        NULL,
        'web',
        'input.prompt',
        $2,
        $3::jsonb
      )
      RETURNING
        "id",
        "seq_id" AS "seqId",
        "content",
        "context_type" AS "contextType",
        "user_message" AS "userMessage"
    `,
    [threadId, firstSeqId, JSON.stringify(userMessage)],
  );
  const messageRow = message.rows[0];
  if (!messageRow) {
    throw new Error("Failed to create append-only chat message fixture");
  }
  assert.equal(messageRow.seqId, String(firstSeqId));
  assert.equal(messageRow.content, null);
  assert.equal(messageRow.contextType, "web");
  assert.deepEqual(messageRow.userMessage, userMessage);

  const nextMessage = await client.query<{ seqId: string }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "content",
        "event_type",
        "seq_id"
      )
      VALUES (
        $1,
        'second typed API migration test',
        'output.message',
        $2
      )
      RETURNING "seq_id" AS "seqId"
    `,
    [threadId, lastSeqId],
  );
  assert.equal(nextMessage.rows[0]?.seqId, String(lastSeqId));

  const sequenceState = await client.query<{ lastSeqId: string }>(
    `
      SELECT "last_chat_event_seq_id" AS "lastSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [threadId],
  );
  assert.equal(sequenceState.rows[0]?.lastSeqId, String(lastSeqId));

  return messageRow.id;
}

async function validateCanonicalDraftStorage(
  client: Client,
  threadId: string,
): Promise<void> {
  const draftUserMessage = {
    version: 1,
    parts: [{ type: "text", text: "canonical API draft" }],
  };
  const canonicalDraft = await client.query<{
    draftUserMessage: unknown;
  }>(
    `
      UPDATE "chat_threads"
      SET "draft_user_message" = $2::jsonb
      WHERE "id" = $1
      RETURNING
        "draft_user_message" AS "draftUserMessage"
    `,
    [threadId, JSON.stringify(draftUserMessage)],
  );
  assert.deepEqual(canonicalDraft.rows[0]?.draftUserMessage, draftUserMessage);
}

async function validateChatEventSourcesAreAppendOnly(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate append-only chat event sources ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  let agentComposeId: string | undefined;
  let threadId: string | undefined;
  let messageId: string | undefined;

  try {
    const agentCompose = await client.query<{ id: string }>(`
      INSERT INTO "agent_composes" ("user_id", "name", "org_id")
      VALUES ('append-only-test-user', 'append-only-migration-test', 'append-only-test-org')
      RETURNING "id"
    `);
    agentComposeId = agentCompose.rows[0]?.id;
    if (!agentComposeId) {
      throw new Error("Failed to create append-only agent compose fixture");
    }

    const thread = await client.query<{ id: string }>(
      `
        INSERT INTO "chat_threads" (
          "user_id",
          "agent_compose_id",
          "title"
        )
        VALUES ('append-only-test-user', $1, 'append-only migration test')
        RETURNING "id"
      `,
      [agentComposeId],
    );
    threadId = thread.rows[0]?.id;
    if (!threadId) {
      throw new Error("Failed to create append-only chat thread fixture");
    }

    // Insert through the canonical table with application-reserved seq_ids.
    messageId = await validateCanonicalChatMessageStorage(client, threadId);
    await validateCanonicalDraftStorage(client, threadId);

    const event = await client.query<{ id: string; seqId: string }>(
      `
        INSERT INTO "chat_thread_events" (
          "user_id",
          "org_id",
          "chat_thread_id",
          "kind",
          "agent_compose_id",
          "title"
        )
        VALUES (
          'append-only-test-user',
          'append-only-test-org',
          $1,
          'created',
          $2,
          'append-only migration test'
        )
        RETURNING "id", "seq_id" AS "seqId"
      `,
      [threadId, agentComposeId],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) {
      throw new Error("Failed to create append-only chat thread event fixture");
    }
    assert.equal(event.rows[0]?.seqId, "1");
    const threadEventSequenceState = await client.query<{
      lastSeqId: string;
    }>(
      `
        SELECT "last_seq_id" AS "lastSeqId"
        FROM "chat_thread_event_sequences"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    assert.equal(threadEventSequenceState.rows[0]?.lastSeqId, "1");

    const nextEvent = await client.query<{ id: string; seqId: string }>(
      `
        INSERT INTO "chat_thread_events" (
          "user_id",
          "org_id",
          "chat_thread_id",
          "kind",
          "agent_compose_id",
          "title"
        )
        VALUES (
          'append-only-test-user',
          'append-only-test-org',
          $1,
          'renamed',
          $2,
          'advanced append-only migration test'
        )
        RETURNING "id", "seq_id" AS "seqId"
      `,
      [threadId, agentComposeId],
    );
    const nextEventId = nextEvent.rows[0]?.id;
    if (!nextEventId) {
      throw new Error("Failed to create second chat thread event fixture");
    }
    assert.equal(nextEvent.rows[0]?.seqId, "2");

    const snapshot = await client.query<{ latestSeqId: string }>(
      `
        INSERT INTO "chat_thread_snapshots" (
          "user_id",
          "org_id",
          "latest_event_id"
        )
        VALUES ('append-only-test-user', 'append-only-test-org', $1)
        RETURNING "latest_event_seq_id" AS "latestSeqId"
      `,
      [eventId],
    );
    assert.equal(snapshot.rows[0]?.latestSeqId, "1");

    const advancedSnapshot = await client.query<{ latestSeqId: string }>(
      `
        UPDATE "chat_thread_snapshots"
        SET "latest_event_id" = $1
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
        RETURNING "latest_event_seq_id" AS "latestSeqId"
      `,
      [nextEventId],
    );
    assert.equal(advancedSnapshot.rows[0]?.latestSeqId, "2");

    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_events",
      query: `UPDATE "chat_events" SET "content" = 'mutated' WHERE "id" = $1`,
      rowId: messageId,
    });
    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_thread_events",
      query: `UPDATE "chat_thread_events" SET "title" = 'mutated' WHERE "id" = $1`,
      rowId: eventId,
    });

    console.log("   ✅ chat_events rejects UPDATE");
    console.log("   ✅ chat_thread_events rejects UPDATE\n");
    console.log("   ✅ chat event writes use application-reserved seq_ids\n");
  } finally {
    await client.query(
      `
        DELETE FROM "chat_thread_snapshots"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    await client.query(
      `
        DELETE FROM "chat_thread_events"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    if (agentComposeId) {
      await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
        agentComposeId,
      ]);
    }
    await client.end();
  }
}

async function validateChatEventContextPointerConstraints(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate chat event context pointer ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const agentComposeId = "00000000-0000-4000-8000-000000074501";
  const threadId = "00000000-0000-4000-8000-000000074502";

  try {
    await client.query(
      `
        INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
        VALUES ($1, 'context-pointer-test-user', 'context-pointer-test', 'context-pointer-test-org')
      `,
      [agentComposeId],
    );
    await client.query(
      `
        INSERT INTO "chat_threads" (
          "id",
          "user_id",
          "agent_compose_id",
          "last_chat_event_seq_id",
          "title"
        )
        VALUES (
          $1,
          'context-pointer-test-user',
          $2,
          2,
          'context pointer test'
        )
      `,
      [threadId, agentComposeId],
    );

    const accepted = await client.query<{
      contextId: string | null;
      contextType: string | null;
    }>(
      `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "user_message",
          "seq_id"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000074510',
            $1,
            'output.message',
            NULL,
            NULL,
            NULL,
            1
          ),
          (
            '00000000-0000-4000-8000-000000074511',
            $1,
            'output.message',
            'slack',
            '00000000-0000-4000-8000-000000074503',
            NULL,
            2
          ),
          (
            '00000000-0000-4000-8000-000000074512',
            $1,
            'input.prompt',
            'web',
            NULL,
            '{"version":1,"parts":[{"type":"text","text":"web discriminator"}]}'::jsonb,
            3
          ),
          (
            '00000000-0000-4000-8000-000000074515',
            $1,
            'input.rejected',
            NULL,
            NULL,
            '{"version":1,"parts":[{"type":"text","text":"rejected input"}]}'::jsonb,
            4
          )
        RETURNING
          "context_type" AS "contextType",
          "context_id" AS "contextId"
      `,
      [threadId],
    );
    assert.deepEqual(accepted.rows, [
      { contextId: null, contextType: null },
      {
        contextId: "00000000-0000-4000-8000-000000074503",
        contextType: "slack",
      },
      { contextId: null, contextType: "web" },
      { contextId: null, contextType: null },
    ]);

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_pair_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_id",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074513',
          $1,
          'output.message',
          '00000000-0000-4000-8000-000000074504',
          3
        )
      `,
      values: [threadId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_type_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074514',
          $1,
          'output.message',
          'discord',
          '00000000-0000-4000-8000-000000074505',
          3
        )
      `,
      values: [threadId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_input_context_type_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "user_message",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074516',
          $1,
          'input.prompt',
          NULL,
          NULL,
          '{"version":1,"parts":[{"type":"text","text":"missing discriminator"}]}'::jsonb,
          5
        )
      `,
      values: [threadId],
    });

    console.log(
      "   ✅ Chat event contexts require input discriminators while allowing context-less rejected inputs\n",
    );
  } finally {
    await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
      agentComposeId,
    ]);
    await client.end();
  }
}

async function runNormalizedComparison(
  dbUrl1: string,
  dbUrl2: string,
): Promise<boolean> {
  console.log(`📸 Running normalized schema comparison...`);
  try {
    execCommand(
      `tsx ${path.join(dirname, "compare-schemas-normalized.ts")} "${dbUrl1}" "${dbUrl2}"`,
      { cwd: PACKAGE_DIR },
    );
    return true;
  } catch {
    return false;
  }
}

async function backupMigrations(): Promise<void> {
  console.log("📦 Backing up current migrations...");
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  await fs.cp(MIGRATIONS_DIR, BACKUP_DIR, { recursive: true });
}

async function restoreMigrations(): Promise<void> {
  console.log("♻️  Restoring original migrations...");
  await fs.access(BACKUP_DIR);
  await fs.rm(RESTORE_DIR, { recursive: true, force: true });
  await fs.cp(BACKUP_DIR, RESTORE_DIR, { recursive: true });
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.rename(RESTORE_DIR, MIGRATIONS_DIR);
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
}

async function addPgVectorExtensionPreludeToGeneratedMigrations(): Promise<void> {
  const sqlFiles = (await fs.readdir(MIGRATIONS_DIR))
    .filter((file) => {
      return file.endsWith(".sql");
    })
    .sort();

  const sqlByFile = await Promise.all(
    sqlFiles.map(async (file) => {
      return {
        file,
        sql: await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8"),
      };
    }),
  );

  const usesPgVector = sqlByFile.some(({ sql }) => {
    return (
      /\bvector\s*\(/i.test(sql) ||
      /\bvector_cosine_ops\b/i.test(sql) ||
      /\bUSING\s+hnsw\b/i.test(sql)
    );
  });
  if (!usesPgVector) {
    return;
  }

  const hasPgVectorExtension = sqlByFile.some(({ sql }) => {
    return /CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?vector"?/i.test(sql);
  });
  if (hasPgVectorExtension) {
    return;
  }

  const firstPgVectorMigration = sqlByFile.find(({ sql }) => {
    return (
      /\bvector\s*\(/i.test(sql) ||
      /\bvector_cosine_ops\b/i.test(sql) ||
      /\bUSING\s+hnsw\b/i.test(sql)
    );
  });
  if (!firstPgVectorMigration) {
    return;
  }

  const migrationPath = path.join(MIGRATIONS_DIR, firstPgVectorMigration.file);
  await fs.writeFile(
    migrationPath,
    `CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint\n${firstPgVectorMigration.sql}`,
  );
  console.log(
    `   Added pgvector extension prelude to generated migration ${firstPgVectorMigration.file}`,
  );
}

async function generateFreshMigrations(): Promise<void> {
  console.log("🔨 Generating fresh migrations from schema...");

  // Delete existing migrations
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });

  // Generate new migrations (non-interactive)
  execCommand("pnpm drizzle-kit generate", { cwd: PACKAGE_DIR });
  await addPgVectorExtensionPreludeToGeneratedMigrations();
}

async function validateSnapshotFiles(): Promise<void> {
  console.log("=== Phase 0: Validate Snapshot Files ===\n");

  // Count SQL files
  const files = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = files
    .filter((f) => {
      return f.endsWith(".sql");
    })
    .sort();

  // Count snapshot files
  const metaFiles = await fs.readdir(path.join(MIGRATIONS_DIR, "meta"));
  const snapshotFiles = metaFiles
    .filter((f) => {
      return f.endsWith("_snapshot.json");
    })
    .sort();

  console.log(`   SQL migrations: ${sqlFiles.length}`);
  console.log(`   Snapshot files: ${snapshotFiles.length}`);

  // Check if counts match
  if (sqlFiles.length !== snapshotFiles.length) {
    console.error(
      `   ❌ Mismatch: ${sqlFiles.length} SQL files but ${snapshotFiles.length} snapshots`,
    );
    throw new Error("Migration count mismatch");
  }

  // Check each migration has a snapshot
  const missingSnapshots: string[] = [];
  for (const sqlFile of sqlFiles) {
    const match = sqlFile.match(/^(\d{4})_/);
    if (!match) continue;

    const idx = match[1];
    const snapshotFile = `${idx}_snapshot.json`;

    if (!snapshotFiles.includes(snapshotFile)) {
      missingSnapshots.push(sqlFile);
    }
  }

  if (missingSnapshots.length > 0) {
    console.error(
      `   ❌ Missing snapshots for migrations: ${missingSnapshots.join(", ")}`,
    );
    throw new Error("Missing snapshot files");
  }

  // Validate snapshot chain integrity
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;

  let prevId: string | undefined;
  let chainBroken = false;
  for (const [position, entry] of entries.entries()) {
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));

    if (position > 0 && snapshot.prevId !== prevId) {
      console.error(`   ❌ Snapshot ${entry.idx} prevId mismatch:`);
      console.error(`      Expected: ${prevId}`);
      console.error(`      Got: ${snapshot.prevId}`);
      chainBroken = true;
      break;
    }

    prevId = snapshot.id;
  }

  if (chainBroken) {
    console.error(`\n❌ SNAPSHOT CHAIN BROKEN`);
    console.error(
      `\n   This means the snapshot system is corrupted and needs to be rebuilt.`,
    );
    console.error(`\n   🔧 How to fix:`);
    console.error(`      1. Reset database: pnpm -F @vm0/db db:reset`);
    console.error(`      2. Delete your manual migration file (if any)`);
    console.error(`      3. Remove migration entry from meta/_journal.json`);
    console.error(`      4. Generate migration: pnpm -F @vm0/db db:generate`);
    console.error(`      5. Apply migration: pnpm -F @vm0/db db:migrate`);
    console.error(`\n   ⚠️  IMPORTANT: Never manually write migration files!`);
    console.error(
      `      Always use 'pnpm -F @vm0/db db:generate' to auto-generate migrations.`,
    );
    console.error(`      Manual migrations break the snapshot chain.\n`);
    throw new Error("Snapshot chain broken");
  }

  console.log(`   ✅ All ${sqlFiles.length} migrations have snapshots`);
  console.log(`   ✅ Snapshot chain validated (id/prevId references intact)`);
  console.log();
}

async function validateMigrationTagReferences(): Promise<void> {
  console.log("=== Phase 0.1: Validate Migration Tag References ===\n");

  const source = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:applyMigrationsUpTo|runMigrationsUpTo)\s*\(/u,
    "Transition validators must reference migrations by tag, not numeric index",
  );

  console.log("   ✅ Transition validators reference migrations by tag\n");
}

async function expectDatabaseError(
  client: Client,
  args: {
    readonly code: string;
    readonly messageIncludes?: string;
    readonly query: string;
    readonly values?: readonly (string | number | null)[];
  },
): Promise<void> {
  try {
    await client.query(args.query, args.values ? [...args.values] : undefined);
  } catch (error) {
    assert.equal(databaseErrorCode(error), args.code);
    if (args.messageIncludes !== undefined) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(args.messageIncludes));
    }
    return;
  }
  throw new Error(`Expected database error ${args.code}`);
}

const CUSTOM_CREDENTIAL_STORAGE_PREVIOUS_MIGRATION = "0838_gifted_korath";
const CUSTOM_CREDENTIAL_STORAGE_MIGRATION =
  "0840_backfill_custom_connector_credential_parents_v1";

const MCP_CUSTOM_CONNECTOR_READERS_PREVIOUS_MIGRATION =
  "0872_curious_yellow_claw";
const MCP_CUSTOM_CONNECTOR_READERS_MIGRATION =
  "0873_prepare_mcp_custom_connector_readers";

async function validateMcpCustomConnectorReaderPreparation(): Promise<void> {
  console.log("=== Validate MCP Custom Connector reader preparation ===\n");
  const testDb = "migration_mcp_custom_connector_readers_test";
  await createDatabase(testDb);
  const client = new Client({ connectionString: createTestDbUrl(testDb) });
  await client.connect();

  const connectorId = "26007000-0000-4000-8000-000000000001";
  const agentId = "26007000-0000-4000-8000-000000000002";
  const mcpConnectorId = "26007000-0000-4000-8000-000000000003";

  try {
    await applyMigrationsUpToTag(
      client,
      MCP_CUSTOM_CONNECTOR_READERS_PREVIOUS_MIGRATION,
    );

    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefixes",
          "header_name",
          "header_template",
          "prefix_templates",
          "mcp_resource",
          "created_by"
        ) VALUES (
          $1,
          'issue-26007-org',
          '_existing-http',
          'Existing HTTP',
          '["https://api.example.test/"]'::jsonb,
          'Authorization',
          'Bearer {{secret}}',
          '["https://api.example.test/"]'::jsonb,
          'legacy-resource',
          'issue-26007-user'
        )
      `,
      [connectorId],
    );
    await client.query(
      `
        INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
        VALUES ($1, 'issue-26007-user', 'issue-26007-agent', 'issue-26007-org')
      `,
      [agentId],
    );
    await client.query(
      `
        INSERT INTO "zero_agents" (
          "id", "org_id", "owner", "name", "visibility"
        ) VALUES (
          $1,
          'issue-26007-org',
          'issue-26007-user',
          'issue-26007-agent',
          'private'
        )
      `,
      [agentId],
    );
    await client.query(
      `
        INSERT INTO "user_custom_connectors" (
          "org_id",
          "user_id",
          "agent_id",
          "custom_connector_id",
          "allow_all_mcp_tools"
        ) VALUES (
          'issue-26007-org',
          'issue-26007-user',
          $1,
          $2,
          true
        )
      `,
      [agentId, connectorId],
    );

    await assert.rejects(
      applyMigrationsUpToTag(client, MCP_CUSTOM_CONNECTOR_READERS_MIGRATION),
      /Unexpected Custom Connector definition state/u,
    );
    await client.query(
      `UPDATE "org_custom_connectors" SET "mcp_resource" = NULL WHERE "id" = $1`,
      [connectorId],
    );
    await assert.rejects(
      applyMigrationsUpToTag(client, MCP_CUSTOM_CONNECTOR_READERS_MIGRATION),
      /Unexpected Custom Connector MCP tool-grant state/u,
    );
    await client.query(
      `UPDATE "user_custom_connectors" SET "allow_all_mcp_tools" = false`,
    );

    await applyMigrationsUpToTag(
      client,
      MCP_CUSTOM_CONNECTOR_READERS_MIGRATION,
    );

    const existingHttp = await client.query<{
      headerName: string | null;
      mcpEndpoint: string | null;
      mcpTransport: string | null;
      prefixes: string[];
    }>(
      `
        SELECT
          "header_name" AS "headerName",
          "mcp_endpoint" AS "mcpEndpoint",
          "mcp_transport" AS "mcpTransport",
          "prefixes"
        FROM "org_custom_connectors"
        WHERE "id" = $1
      `,
      [connectorId],
    );
    assert.deepEqual(existingHttp.rows, [
      {
        headerName: "Authorization",
        mcpEndpoint: null,
        mcpTransport: null,
        prefixes: ["https://api.example.test/"],
      },
    ]);

    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefixes",
          "header_name",
          "header_template",
          "prefix_templates",
          "mcp_endpoint",
          "mcp_transport",
          "created_by"
        ) VALUES (
          $1,
          'issue-26007-org',
          '_mcp-reader',
          'MCP Reader',
          '[]'::jsonb,
          NULL,
          NULL,
          '[]'::jsonb,
          'https://mcp.example.test/server',
          'streamable-http',
          'issue-26007-user'
        )
      `,
      [mcpConnectorId],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        INSERT INTO "org_custom_connectors" (
          "org_id", "slug", "display_name", "prefixes", "header_name",
          "header_template", "prefix_templates", "mcp_endpoint",
          "mcp_transport", "created_by"
        ) VALUES (
          'issue-26007-org', '_partial-mcp', 'Partial MCP', '[]'::jsonb,
          NULL, NULL, '[]'::jsonb, 'https://mcp.example.test/partial',
          NULL, 'issue-26007-user'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        INSERT INTO "org_custom_connectors" (
          "org_id", "slug", "display_name", "prefixes", "header_name",
          "header_template", "prefix_templates", "mcp_endpoint",
          "mcp_transport", "created_by"
        ) VALUES (
          'issue-26007-org', '_hybrid-mcp', 'Hybrid MCP',
          '["https://api.example.test/"]'::jsonb, NULL, NULL,
          '[]'::jsonb, 'https://mcp.example.test/hybrid',
          'streamable-http', 'issue-26007-user'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        INSERT INTO "org_custom_connectors" (
          "org_id", "slug", "display_name", "prefixes", "header_name",
          "header_template", "prefix_templates", "created_by"
        ) VALUES (
          'issue-26007-org', '_headerless-http', 'Headerless HTTP',
          '["https://api.example.test/"]'::jsonb, NULL, NULL,
          '["https://api.example.test/"]'::jsonb, 'issue-26007-user'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_mcp",
      query: `
        UPDATE "org_custom_connectors"
        SET "mcp_resource" = 'legacy-resource'
        WHERE "id" = $1
      `,
      values: [connectorId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_user_custom_connectors_mcp_grant",
      query: `
        UPDATE "user_custom_connectors"
        SET "allow_all_mcp_tools" = true
        WHERE "custom_connector_id" = $1
      `,
      values: [connectorId],
    });

    console.log("   ✅ legacy MCP state aborts instead of being cleared");
    console.log("   ✅ existing HTTP definitions remain valid");
    console.log("   ✅ only exhaustive MCP definition rows are accepted\n");
  } finally {
    await client.end();
    await dropDatabase(testDb);
  }
}

async function validateCustomCredentialStorageGenerationBackfill(): Promise<void> {
  console.log(
    "=== Validate custom credential storage generation backfill ===\n",
  );
  const testDb = "migration_custom_credential_storage_generation_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    canonical: "00000000-0000-4000-8000-000000084001",
    legacy: "00000000-0000-4000-8000-000000084002",
    duplicate: "00000000-0000-4000-8000-000000084003",
    oauth: "00000000-0000-4000-8000-000000084004",
    preParented: "00000000-0000-4000-8000-000000084005",
    oldInsert: "00000000-0000-4000-8000-000000084006",
    oldUpdate: "00000000-0000-4000-8000-000000084007",
    futureVersion: "00000000-0000-4000-8000-000000084008",
    orgId: "custom-storage-generation-org",
    userId: "custom-storage-generation-user",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CUSTOM_CREDENTIAL_STORAGE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO "org_custom_connectors" (
            "id",
            "org_id",
            "slug",
            "display_name",
            "prefixes",
            "header_name",
            "header_template",
            "auth_mode",
            "created_by"
          ) VALUES
            ($1, $9, '_storage-canonical', 'Canonical', '["https://canonical.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10),
            ($2, $9, '_storage-legacy', 'Legacy', '["https://legacy.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10),
            ($3, $9, '_storage-duplicate', 'Duplicate', '["https://duplicate.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10),
            ($4, $9, '_storage-oauth', 'OAuth', '["https://oauth.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'oauth', $10),
            ($5, $9, '_storage-pre-parented', 'Pre-parented', '["https://parented.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10),
            ($6, $9, '_storage-old-insert', 'Old insert', '["https://old-insert.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10),
            ($7, $9, '_storage-old-update', 'Old update', '["https://old-update.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10),
            ($8, $9, '_storage-future', 'Future version', '["https://future.example.test/"]'::jsonb, 'Authorization', 'Bearer {{secret}}', 'manual', $10)
        `,
        [
          fixture.canonical,
          fixture.legacy,
          fixture.duplicate,
          fixture.oauth,
          fixture.preParented,
          fixture.oldInsert,
          fixture.oldUpdate,
          fixture.futureVersion,
          fixture.orgId,
          fixture.userId,
        ],
      );
      await client.query(
        `
          INSERT INTO "org_custom_connector_oauth_configs" (
            "connector_id",
            "org_id",
            "provider_adapter",
            "client_id",
            "encrypted_client_secret",
            "authorization_url",
            "token_url",
            "token_endpoint_auth_method",
            "pkce_method"
          ) VALUES (
            $1,
            $2,
            'standard',
            'migration-client',
            'migration-secret',
            'https://oauth.example.test/authorize',
            'https://oauth.example.test/token',
            'client_secret_post',
            'none'
          )
        `,
        [fixture.oauth, fixture.orgId],
      );
      await client.query("COMMIT");

      await client.query(
        `
          INSERT INTO "org_custom_connector_values" (
            "connector_id",
            "user_id",
            "org_id",
            "kind",
            "key",
            "encrypted_value"
          ) VALUES
            ($1, $6, $7, 'secret', 'api_key', 'canonical-value'),
            ($2, $6, $7, 'secret', 'api_key', 'duplicate-value'),
            ($3, $6, $7, 'secret', 'api_key', 'oauth-value'),
            ($4, $6, $7, 'secret', 'api_key', 'pre-parented-value'),
            ($5, $6, $7, 'secret', 'api_key', 'old-update-value')
        `,
        [
          fixture.canonical,
          fixture.duplicate,
          fixture.oauth,
          fixture.preParented,
          fixture.oldUpdate,
          fixture.userId,
          fixture.orgId,
        ],
      );
      await client.query(
        `
          INSERT INTO "org_custom_connector_secrets" (
            "connector_id",
            "user_id",
            "org_id",
            "encrypted_value"
          ) VALUES
            ($1, $3, $4, 'legacy-value'),
            ($2, $3, $4, 'duplicate-legacy-value')
        `,
        [fixture.legacy, fixture.duplicate, fixture.userId, fixture.orgId],
      );
      await client.query(
        `
          INSERT INTO "connectors" (
            "custom_connector_id",
            "auth_method",
            "storage_version",
            "user_id",
            "org_id"
          ) VALUES ($1, 'oauth', 7, $2, $3)
        `,
        [fixture.preParented, fixture.userId, fixture.orgId],
      );

      await applyMigrationsUpToTag(client, CUSTOM_CREDENTIAL_STORAGE_MIGRATION);

      const definitions = await client.query<{
        id: string;
        storageVersion: number;
      }>(
        `
          SELECT "id", "storage_version"::int AS "storageVersion"
          FROM "org_custom_connectors"
          WHERE "org_id" = $1
          ORDER BY "id"
        `,
        [fixture.orgId],
      );
      assert.equal(definitions.rows.length, 8);
      assert.ok(
        definitions.rows.every((definition) => {
          return definition.storageVersion === 1;
        }),
      );

      const parents = await client.query<{
        authMethod: string;
        customConnectorId: string;
        storageVersion: number;
      }>(
        `
          SELECT
            "custom_connector_id" AS "customConnectorId",
            "auth_method" AS "authMethod",
            "storage_version"::int AS "storageVersion"
          FROM "connectors"
          WHERE "org_id" = $1
            AND "user_id" = $2
            AND "custom_connector_id" IS NOT NULL
          ORDER BY "custom_connector_id"
        `,
        [fixture.orgId, fixture.userId],
      );
      assert.deepEqual(parents.rows, [
        {
          authMethod: "manual",
          customConnectorId: fixture.canonical,
          storageVersion: 1,
        },
        {
          authMethod: "manual",
          customConnectorId: fixture.legacy,
          storageVersion: 1,
        },
        {
          authMethod: "manual",
          customConnectorId: fixture.duplicate,
          storageVersion: 1,
        },
        {
          authMethod: "oauth",
          customConnectorId: fixture.preParented,
          storageVersion: 7,
        },
        {
          authMethod: "manual",
          customConnectorId: fixture.oldUpdate,
          storageVersion: 1,
        },
      ]);
      const sourceCounts = await client.query<{
        legacyCount: number;
        valueCount: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM "org_custom_connector_secrets") AS "legacyCount",
          (SELECT count(*)::int FROM "org_custom_connector_values") AS "valueCount"
      `);
      assert.deepEqual(sourceCounts.rows, [{ legacyCount: 2, valueCount: 5 }]);

      const oldWriterUpsert = `
        INSERT INTO "org_custom_connector_values" (
          "connector_id",
          "user_id",
          "org_id",
          "kind",
          "key",
          "encrypted_value"
        ) VALUES ($1, $2, $3, 'secret', 'api_key', $4)
        ON CONFLICT ("connector_id", "user_id", "kind", "key")
        DO UPDATE SET
          "encrypted_value" = excluded."encrypted_value",
          "updated_at" = now()
      `;
      await client.query(oldWriterUpsert, [
        fixture.oldInsert,
        fixture.userId,
        fixture.orgId,
        "old-insert-value",
      ]);
      await client.query(
        `DELETE FROM "connectors" WHERE "custom_connector_id" = $1`,
        [fixture.oldUpdate],
      );
      await client.query(oldWriterUpsert, [
        fixture.oldUpdate,
        fixture.userId,
        fixture.orgId,
        "old-update-replacement",
      ]);
      await client.query(
        `UPDATE "org_custom_connectors" SET "storage_version" = 2 WHERE "id" = $1`,
        [fixture.futureVersion],
      );
      await client.query(oldWriterUpsert, [
        fixture.futureVersion,
        fixture.userId,
        fixture.orgId,
        "future-version-value",
      ]);

      const transitionParents = await client.query<{
        customConnectorId: string;
        storageVersion: number;
      }>(
        `
          SELECT
            "custom_connector_id" AS "customConnectorId",
            "storage_version"::int AS "storageVersion"
          FROM "connectors"
          WHERE "custom_connector_id" = ANY($1::uuid[])
          ORDER BY "custom_connector_id"
        `,
        [[fixture.oldInsert, fixture.oldUpdate, fixture.futureVersion]],
      );
      assert.deepEqual(transitionParents.rows, [
        {
          customConnectorId: fixture.oldInsert,
          storageVersion: 1,
        },
        {
          customConnectorId: fixture.oldUpdate,
          storageVersion: 1,
        },
      ]);

      const transitionObjects = await client.query<{
        functionCount: number;
        triggerCount: number;
      }>(`
        SELECT
          (
            SELECT count(*)::int
            FROM pg_proc
            WHERE proname = 'ensure_custom_manual_connector_parent_v1'
          ) AS "functionCount",
          (
            SELECT count(*)::int
            FROM pg_trigger
            WHERE tgname = 'org_custom_connector_values_ensure_parent_v1'
              AND NOT tgisinternal
          ) AS "triggerCount"
      `);
      assert.deepEqual(transitionObjects.rows, [
        { functionCount: 1, triggerCount: 1 },
      ]);

      console.log("   ✅ Existing manual credentials receive one parent");
      console.log("   ✅ OAuth and pre-parented identities remain unchanged");
      console.log(
        "   ✅ Outgoing insert and update statements create v1 parents",
      );
      console.log("   ✅ Outgoing writers cannot certify a future version\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

type PermanentTrigger = {
  readonly definition: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly triggerName: string;
};

type PermanentFunction = {
  readonly bodyHash: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly kind: string;
  readonly schemaName: string;
};

// Exported from a database built by the existing migration chain. Extension-owned
// pgcrypto and vector functions are deliberately absent from the function list.
const EXPECTED_PERMANENT_TRIGGERS = [
  {
    definition:
      "CREATE TRIGGER bridge_invalidated_goal_continuation_0829 BEFORE INSERT ON public.chat_events FOR EACH ROW WHEN (((new.event_type = 'input.rejected'::text) AND (new.error = 'Goal continuation no longer matches the active goal'::text))) EXECUTE FUNCTION bridge_invalidated_goal_continuation_0829()",
    schemaName: "public",
    tableName: "chat_events",
    triggerName: "bridge_invalidated_goal_continuation_0829",
  },
  {
    definition:
      "CREATE TRIGGER bridge_goal_only_chat_event_run_group_0810 BEFORE INSERT ON public.chat_events FOR EACH ROW EXECUTE FUNCTION bridge_goal_only_chat_event_run_group_0810()",
    schemaName: "public",
    tableName: "chat_events",
    triggerName: "bridge_goal_only_chat_event_run_group_0810",
  },
  {
    definition:
      "CREATE TRIGGER chat_events_reject_update BEFORE UPDATE ON public.chat_events FOR EACH ROW EXECUTE FUNCTION reject_chat_event_source_update()",
    schemaName: "public",
    tableName: "chat_events",
    triggerName: "chat_events_reject_update",
  },
  {
    definition:
      "CREATE TRIGGER allocate_legacy_chat_thread_event_seq_id BEFORE INSERT ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION allocate_legacy_chat_thread_event_seq_id()",
    schemaName: "public",
    tableName: "chat_thread_events",
    triggerName: "allocate_legacy_chat_thread_event_seq_id",
  },
  {
    definition:
      "CREATE TRIGGER chat_thread_events_reject_update BEFORE UPDATE ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION reject_chat_event_source_update()",
    schemaName: "public",
    tableName: "chat_thread_events",
    triggerName: "chat_thread_events_reject_update",
  },
  {
    definition:
      "CREATE TRIGGER fill_legacy_chat_thread_snapshot_event_seq_id BEFORE INSERT OR UPDATE ON public.chat_thread_snapshots FOR EACH ROW EXECUTE FUNCTION fill_legacy_chat_thread_snapshot_event_seq_id()",
    schemaName: "public",
    tableName: "chat_thread_snapshots",
    triggerName: "fill_legacy_chat_thread_snapshot_event_seq_id",
  },
  {
    definition:
      "CREATE TRIGGER chat_threads_normalize_computer_access BEFORE INSERT OR UPDATE OF computer_use_host_id, cloud_browser_enabled ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION chat_threads_normalize_computer_access()",
    schemaName: "public",
    tableName: "chat_threads",
    triggerName: "chat_threads_normalize_computer_access",
  },
  {
    definition:
      "CREATE TRIGGER enforce_hosted_deployment_scope_0753 BEFORE INSERT ON public.hosted_deployments FOR EACH ROW EXECUTE FUNCTION enforce_hosted_deployment_scope_0753()",
    schemaName: "public",
    tableName: "hosted_deployments",
    triggerName: "enforce_hosted_deployment_scope_0753",
  },
  {
    definition:
      "CREATE TRIGGER canonicalize_hosted_site_scope_0753 BEFORE INSERT OR UPDATE OF created_from_run_id, requested_slug, chat_thread_id ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION canonicalize_hosted_site_scope_0753()",
    schemaName: "public",
    tableName: "hosted_sites",
    triggerName: "canonicalize_hosted_site_scope_0753",
  },
  {
    definition:
      "CREATE TRIGGER hosted_sites_delete_artifact_registry AFTER DELETE ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('hosted-site')",
    schemaName: "public",
    tableName: "hosted_sites",
    triggerName: "hosted_sites_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER image_artifacts_delete_artifact_registry AFTER DELETE ON public.image_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('image')",
    schemaName: "public",
    tableName: "image_artifacts",
    triggerName: "image_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER trg_org_custom_connector_oauth_configs_mode AFTER INSERT OR DELETE OR UPDATE ON public.org_custom_connector_oauth_configs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()",
    schemaName: "public",
    tableName: "org_custom_connector_oauth_configs",
    triggerName: "trg_org_custom_connector_oauth_configs_mode",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER trg_org_custom_connectors_oauth_mode AFTER INSERT OR UPDATE ON public.org_custom_connectors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()",
    schemaName: "public",
    tableName: "org_custom_connectors",
    triggerName: "trg_org_custom_connectors_oauth_mode",
  },
  {
    definition:
      "CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()",
    schemaName: "public",
    tableName: "org_metadata",
    triggerName: "ensure_legacy_org_metadata_plan_entitlement",
  },
  {
    definition:
      "CREATE TRIGGER sync_legacy_org_plan_entitlement_can_buy_credits BEFORE INSERT OR UPDATE OF plan_key ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_legacy_org_plan_entitlement_can_buy_credits()",
    schemaName: "public",
    tableName: "org_plan_entitlements",
    triggerName: "sync_legacy_org_plan_entitlement_can_buy_credits",
  },
  {
    definition:
      "CREATE TRIGGER presentation_artifacts_delete_artifact_registry AFTER DELETE ON public.presentation_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('presentation')",
    schemaName: "public",
    tableName: "presentation_artifacts",
    triggerName: "presentation_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER run_uploaded_files_delete_artifact_registry AFTER DELETE ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('file')",
    schemaName: "public",
    tableName: "run_uploaded_files",
    triggerName: "run_uploaded_files_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER run_uploaded_files_queue_artifact_catalog AFTER INSERT OR UPDATE OF run_id, chat_thread_id, user_id, org_id, external_id, filename, content_type, url, preview_image_url, metadata ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION queue_artifact_catalog_file()",
    schemaName: "public",
    tableName: "run_uploaded_files",
    triggerName: "run_uploaded_files_queue_artifact_catalog",
  },
  {
    definition:
      "CREATE TRIGGER video_artifacts_delete_artifact_registry AFTER DELETE ON public.video_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('video')",
    schemaName: "public",
    tableName: "video_artifacts",
    triggerName: "video_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER bridge_goal_only_zero_run_group_0810 BEFORE INSERT OR UPDATE OF run_group_id, goal_id ON public.zero_runs FOR EACH ROW EXECUTE FUNCTION bridge_goal_only_zero_run_group_0810()",
    schemaName: "public",
    tableName: "zero_runs",
    triggerName: "bridge_goal_only_zero_run_group_0810",
  },
] as const satisfies readonly PermanentTrigger[];

const EXPECTED_PERMANENT_FUNCTIONS = [
  {
    bodyHash: "6b1b5ad47ec35bcbaad3fa95d86ef027",
    functionName: "allocate_legacy_chat_thread_event_seq_id",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "4886a7314cbaa815a4f8290a16a2f528",
    functionName: "assert_org_custom_connector_oauth_mode",
    identityArguments: "target_connector_id uuid, target_org_id text",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "d222c803fed6a784bf53288dd866f2a2",
    functionName: "bridge_goal_only_chat_event_run_group_0810",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "14663ff71eec325962f2784692c96937",
    functionName: "bridge_invalidated_goal_continuation_0829",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "24620b451e6c4d3c61ca9e449f5faa19",
    functionName: "bridge_goal_only_zero_run_group_0810",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "28abc81d6fe2975374d21c68ee6ac1a7",
    functionName: "canonicalize_hosted_site_scope_0753",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7f12cb6026b4e6d6638aaa22e0a93514",
    functionName: "chat_threads_normalize_computer_access",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "3879e0228971b9f64e4bf8439ec5df4b",
    functionName: "delete_artifact_registry_entity",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "8531b56175d6c695da79c88e7b5c34cf",
    functionName: "enforce_hosted_deployment_scope_0753",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "15e3309d90f7237e3b5c28fbf23a439d",
    functionName: "enforce_org_custom_connector_oauth_mode",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "903925177de13d29257fec494957b1cd",
    functionName: "ensure_legacy_org_metadata_plan_entitlement",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7740cf65befb5e06a73e1f21bcfdd5cc",
    functionName: "fill_legacy_chat_thread_snapshot_event_seq_id",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "bcc84b560ab4bb6a1d2ebcc8090ceab1",
    functionName: "queue_artifact_catalog_file",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "519c7504c787a49c4c6bea8a588711fc",
    functionName: "reject_chat_event_source_update",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "daf97695043bdbafd864f7ff7a8f8d5d",
    functionName: "sync_legacy_org_plan_entitlement_can_buy_credits",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
] as const satisfies readonly PermanentFunction[];

function assertPermanentInventory(args: {
  readonly actual: readonly string[];
  readonly expected: readonly string[];
  readonly label: string;
}): void {
  const actual = new Set(args.actual);
  const expected = new Set(args.expected);
  const missing = args.expected.filter((object) => {
    return !actual.has(object);
  });
  const unexpected = args.actual.filter((object) => {
    return !expected.has(object);
  });

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        `Permanent ${args.label} inventory mismatch`,
        `Missing ${args.label}: ${missing.join(", ") || "none"}`,
        `Unexpected ${args.label}: ${unexpected.join(", ") || "none"}`,
      ].join("\n"),
    );
  }
}

async function validatePermanentTriggerAndFunctionInventory(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1: Validate permanent trigger and function inventory ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // pg_get_triggerdef output depends on search_path.
    await client.query(`SET search_path TO public, pg_catalog`);
    const triggers = await client.query<PermanentTrigger>(`
      SELECT
        namespace."nspname" AS "schemaName",
        relation."relname" AS "tableName",
        catalog_trigger."tgname" AS "triggerName",
        pg_catalog.pg_get_triggerdef(catalog_trigger."oid") AS "definition"
      FROM pg_catalog."pg_trigger" AS catalog_trigger
      INNER JOIN pg_catalog."pg_class" AS relation
        ON relation."oid" = catalog_trigger."tgrelid"
      INNER JOIN pg_catalog."pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = current_schema()
        AND namespace."nspname" NOT LIKE 'pg_temp_%'
        AND NOT catalog_trigger."tgisinternal"
      ORDER BY
        namespace."nspname",
        relation."relname",
        catalog_trigger."tgname"
    `);
    const functions = await client.query<PermanentFunction>(`
      SELECT
        namespace."nspname" AS "schemaName",
        catalog_function."proname" AS "functionName",
        pg_catalog.pg_get_function_identity_arguments(catalog_function."oid")
          AS "identityArguments",
        catalog_function."prokind"::text AS "kind",
        pg_catalog.md5(catalog_function."prosrc") AS "bodyHash"
      FROM pg_catalog."pg_proc" AS catalog_function
      INNER JOIN pg_catalog."pg_namespace" AS namespace
        ON namespace."oid" = catalog_function."pronamespace"
      WHERE namespace."nspname" = current_schema()
        AND namespace."nspname" NOT LIKE 'pg_temp_%'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog."pg_depend" AS dependency
          WHERE dependency."classid" = 'pg_catalog.pg_proc'::regclass
            AND dependency."objid" = catalog_function."oid"
            AND dependency."refclassid" = 'pg_catalog.pg_extension'::regclass
            AND dependency."deptype" = 'e'
        )
      ORDER BY
        namespace."nspname",
        catalog_function."proname",
        pg_catalog.pg_get_function_identity_arguments(catalog_function."oid")
    `);

    const triggerKey = (trigger: PermanentTrigger): string => {
      return `${trigger.schemaName}.${trigger.tableName}.${trigger.triggerName} [${trigger.definition}]`;
    };
    const functionKey = (catalogFunction: PermanentFunction): string => {
      return `${catalogFunction.schemaName}.${catalogFunction.functionName}(${catalogFunction.identityArguments}) [${catalogFunction.kind}] [body md5=${catalogFunction.bodyHash}]`;
    };

    assertPermanentInventory({
      actual: triggers.rows.map(triggerKey),
      expected: EXPECTED_PERMANENT_TRIGGERS.map(triggerKey),
      label: "triggers",
    });
    assertPermanentInventory({
      actual: functions.rows.map(functionKey),
      expected: EXPECTED_PERMANENT_FUNCTIONS.map(functionKey),
      label: "functions",
    });

    console.log("   ✅ Permanent trigger and function inventories match\n");
  } finally {
    await client.end();
  }
}

async function validatePermanentArtifactTriggerBehavior(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.2: Validate permanent artifact trigger behavior ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const fixture = {
    composeId: "00000000-0000-4000-8000-000000246701",
    sessionId: "00000000-0000-4000-8000-000000246702",
    firstRunId: "00000000-0000-4000-8000-000000246703",
    secondRunId: "00000000-0000-4000-8000-000000246704",
    firstThreadId: "00000000-0000-4000-8000-000000246705",
    secondThreadId: "00000000-0000-4000-8000-000000246706",
    hostedSiteId: "00000000-0000-4000-8000-000000246707",
    presentationSiteId: "00000000-0000-4000-8000-000000246708",
    scopedSiteId: "00000000-0000-4000-8000-000000246709",
    directFileId: "00000000-0000-4000-8000-000000246710",
    queuedFileId: "00000000-0000-4000-8000-000000246711",
    imageFileId: "00000000-0000-4000-8000-000000246712",
    videoFileId: "00000000-0000-4000-8000-000000246713",
    imageId: "00000000-0000-4000-8000-000000246714",
    presentationId: "00000000-0000-4000-8000-000000246715",
    videoId: "00000000-0000-4000-8000-000000246716",
    orgId: "permanent-artifact-trigger-org",
    userId: "permanent-artifact-trigger-user",
  } as const;
  const registryIds = [
    "00000000-0000-4000-8000-000000246721",
    "00000000-0000-4000-8000-000000246722",
    "00000000-0000-4000-8000-000000246723",
    "00000000-0000-4000-8000-000000246724",
    "00000000-0000-4000-8000-000000246725",
  ] as const;

  try {
    await client.query(
      `INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
       VALUES ($1, $2, 'permanent-artifact-trigger-test', $3)`,
      [fixture.composeId, fixture.userId, fixture.orgId],
    );
    await client.query(
      `INSERT INTO "agent_sessions" (
         "id", "user_id", "org_id", "agent_compose_id"
       )
       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.userId, fixture.orgId, fixture.composeId],
    );
    await client.query(
      `INSERT INTO "agent_runs" (
         "id", "user_id", "session_id", "status", "prompt", "org_id"
       )
       VALUES
         ($1, $3, $4, 'running', 'first scoped deployment', $5),
         ($2, $3, $4, 'running', 'second scoped deployment', $5)`,
      [
        fixture.firstRunId,
        fixture.secondRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    );
    await client.query(
      `INSERT INTO "chat_threads" (
         "id", "user_id", "agent_compose_id", "title"
       )
       VALUES
         ($1, $3, $4, 'First permanent artifact trigger chat'),
         ($2, $3, $4, 'Second permanent artifact trigger chat')`,
      [
        fixture.firstThreadId,
        fixture.secondThreadId,
        fixture.userId,
        fixture.composeId,
      ],
    );
    await client.query(
      `INSERT INTO "zero_runs" ("id", "trigger_source", "chat_thread_id")
       VALUES
         ($1, 'chat', $3),
         ($2, 'chat', $4)`,
      [
        fixture.firstRunId,
        fixture.secondRunId,
        fixture.firstThreadId,
        fixture.secondThreadId,
      ],
    );
    await client.query(
      `INSERT INTO "run_uploaded_files" (
         "id", "source", "external_id", "user_id", "org_id", "url"
       )
       VALUES
         ($1, 'web', 'direct-file', $5, NULL, NULL),
         ($2, 'web', 'queued-file', $5, $6, 'https://example.invalid/queued-file'),
         ($3, 'web', 'image-file', $5, NULL, NULL),
         ($4, 'web', 'video-file', $5, NULL, NULL)`,
      [
        fixture.directFileId,
        fixture.queuedFileId,
        fixture.imageFileId,
        fixture.videoFileId,
        fixture.userId,
        fixture.orgId,
      ],
    );
    const queuedFile = await client.query<{
      authorUserId: string;
      orgId: string;
    }>(
      `SELECT
         "author_user_id" AS "authorUserId",
         "org_id" AS "orgId"
       FROM "artifact_catalog_pending_files"
       WHERE "file_id" = $1`,
      [fixture.queuedFileId],
    );
    assert.deepEqual(queuedFile.rows, [
      { authorUserId: fixture.userId, orgId: fixture.orgId },
    ]);

    await client.query(
      `INSERT INTO "hosted_sites" (
         "id", "org_id", "user_id", "slug", "public_slug",
         "requested_slug", "chat_thread_id"
       )
       VALUES
         ($1, $4, $5, 'permanent-hosted-site', 'permanent-hosted-site',
          'permanent-hosted-site', NULL),
         ($2, $4, $5, 'permanent-presentation', 'permanent-presentation',
          'permanent-presentation', NULL),
         ($3, $4, $5, 'permanent-scoped-site', 'permanent-scoped-site',
          'permanent-scoped-site', $6)`,
      [
        fixture.hostedSiteId,
        fixture.presentationSiteId,
        fixture.scopedSiteId,
        fixture.orgId,
        fixture.userId,
        fixture.firstThreadId,
      ],
    );
    await client.query(
      `INSERT INTO "image_artifacts" ("id", "file_id") VALUES ($1, $2)`,
      [fixture.imageId, fixture.imageFileId],
    );
    await client.query(
      `INSERT INTO "presentation_artifacts" ("id", "hosted_site_id")
       VALUES ($1, $2)`,
      [fixture.presentationId, fixture.presentationSiteId],
    );
    await client.query(
      `INSERT INTO "video_artifacts" ("id", "file_id") VALUES ($1, $2)`,
      [fixture.videoId, fixture.videoFileId],
    );
    await client.query(
      `INSERT INTO "artifacts" (
         "id", "org_id", "author_user_id", "kind", "entity_id",
         "logical_key", "projection_file_id", "projection_created_at", "title"
       )
       VALUES
         ($1, $6, $7, 'hosted-site', $8, 'permanent-hosted-site', $9, now(), 'Hosted site'),
         ($2, $6, $7, 'image', $10, 'permanent-image', $11, now(), 'Image'),
         ($3, $6, $7, 'presentation', $12, 'permanent-presentation', $13, now(), 'Presentation'),
         ($4, $6, $7, 'video', $14, 'permanent-video', $15, now(), 'Video'),
         ($5, $6, $7, 'file', $16, 'permanent-file', $16, now(), 'File')`,
      [
        ...registryIds,
        fixture.orgId,
        fixture.userId,
        fixture.hostedSiteId,
        fixture.directFileId,
        fixture.imageId,
        fixture.imageFileId,
        fixture.presentationId,
        fixture.queuedFileId,
        fixture.videoId,
        fixture.videoFileId,
        fixture.directFileId,
      ],
    );

    await client.query(`DELETE FROM "hosted_sites" WHERE "id" = $1`, [
      fixture.hostedSiteId,
    ]);
    await client.query(`DELETE FROM "image_artifacts" WHERE "id" = $1`, [
      fixture.imageId,
    ]);
    await client.query(`DELETE FROM "presentation_artifacts" WHERE "id" = $1`, [
      fixture.presentationId,
    ]);
    await client.query(`DELETE FROM "video_artifacts" WHERE "id" = $1`, [
      fixture.videoId,
    ]);
    await client.query(`DELETE FROM "run_uploaded_files" WHERE "id" = $1`, [
      fixture.directFileId,
    ]);

    const remainingRegistryRows = await client.query<{ kind: string }>(
      `SELECT "kind"
       FROM "artifacts"
       WHERE "id" = ANY($1::uuid[])
       ORDER BY "kind"`,
      [[...registryIds]],
    );
    assert.deepEqual(remainingRegistryRows.rows, []);

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "Hosted site belongs to a different chat",
      query: `INSERT INTO "hosted_deployments" (
        "site_id", "org_id", "user_id", "run_id", "status", "r2_prefix",
        "manifest", "manifest_hash", "content_hash", "file_count",
        "size_bytes", "url"
      )
      VALUES (
        $1, $2, $3, $4, 'uploading', 'permanent-out-of-scope', '{}'::jsonb,
        repeat('0', 64), repeat('0', 64), 0, 0,
        'https://out-of-scope.invalid'
      )`,
      values: [
        fixture.scopedSiteId,
        fixture.orgId,
        fixture.userId,
        fixture.secondRunId,
      ],
    });

    console.log(
      "   ✅ Artifact registry cascades, catalog queueing, and hosted deployment scope enforcement work\n",
    );
  } finally {
    await client.query(`DELETE FROM "artifacts" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(`DELETE FROM "hosted_deployments" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(`DELETE FROM "hosted_sites" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(
      `DELETE FROM "run_uploaded_files" WHERE "user_id" = $1`,
      [fixture.userId],
    );
    await client.query(`DELETE FROM "agent_composes" WHERE "id" = $1`, [
      fixture.composeId,
    ]);
    await client.end();
  }
}

async function validateConnectorCatalogFinalConstraints(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.6: Validate final connector catalog constraints ===\n",
  );
  const attemptConstraint =
    "connector_catalog_sync_state_attempt_cache_reuse_complete";
  const candidateConstraint =
    "connector_catalog_sync_state_rejected_candidate_complete";
  const authorityConstraint =
    "connector_catalog_sync_state_rejection_authority_complete";

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO "connector_catalog_sync_state" (
        "source_id",
        "schema_version",
        "last_attempt_at",
        "last_attempt_outcome",
        "last_attempt_reused_cached_rejection",
        "last_failure_code",
        "last_rejected_catalog_version",
        "last_rejected_catalog_key",
        "last_rejected_catalog_digest",
        "last_rejected_pointer_etag",
        "last_rejected_failure_code",
        "last_rejected_backend_version",
        "last_rejected_build_commit_sha"
      )
      VALUES
        (
          'migration-final-catalog-accepted',
          1,
          '2026-07-25 00:00:00',
          'accepted',
          FALSE,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        ),
        (
          'migration-final-catalog-rejected',
          1,
          '2026-07-25 00:00:00',
          'rejected',
          TRUE,
          'invalid-artifact',
          '2026-07-25.1',
          'connectors/v1/releases/2026-07-25.1/catalog.json',
          'sha256:${"b".repeat(64)}',
          '"final-authority-etag"',
          'invalid-artifact',
          '1.319.0',
          '${"a".repeat(40)}'
        )
    `);
    const validRows = await client.query<{ source_id: string }>(`
      SELECT "source_id"
      FROM "connector_catalog_sync_state"
      WHERE "source_id" IN (
        'migration-final-catalog-accepted',
        'migration-final-catalog-rejected'
      )
      ORDER BY "source_id"
    `);
    assert.deepEqual(
      validRows.rows.map((row) => {
        return row.source_id;
      }),
      ["migration-final-catalog-accepted", "migration-final-catalog-rejected"],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state"
          ("source_id", "schema_version", "last_attempt_reused_cached_rejection")
        VALUES ('invalid-provenance-without-attempt', 1, FALSE)
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_attempt_at",
          "last_attempt_outcome",
          "last_failure_code"
        )
        VALUES (
          'invalid-missing-attempt-provenance',
          1,
          '2026-07-25 00:00:00',
          'rejected',
          'source-unavailable'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_attempt_at",
          "last_attempt_outcome",
          "last_attempt_reused_cached_rejection"
        )
        VALUES (
          'invalid-reused-accepted-attempt',
          1,
          '2026-07-25 00:00:00',
          'accepted',
          TRUE
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: candidateConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_catalog_version",
          "last_rejected_failure_code",
          "last_rejected_backend_version"
        )
        VALUES (
          'invalid-partial-rejected-candidate',
          1,
          '2026-07-25.2',
          'invalid-artifact',
          '1.319.0'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_catalog_version",
          "last_rejected_catalog_key",
          "last_rejected_catalog_digest",
          "last_rejected_failure_code"
        )
        VALUES (
          'invalid-candidate-without-authority',
          1,
          '2026-07-25.3',
          'connectors/v1/releases/2026-07-25.3/catalog.json',
          'sha256:${"c".repeat(64)}',
          'invalid-artifact'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state"
          ("source_id", "schema_version", "last_rejected_backend_version")
        VALUES ('invalid-authority-without-candidate', 1, '1.319.0')
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_pointer_etag",
          "last_rejected_failure_code",
          "last_rejected_backend_version"
        )
        VALUES (
          'invalid-rejection-backend-version',
          1,
          '"invalid-version-etag"',
          'invalid-pointer',
          '1.319.0-rc.1'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_pointer_etag",
          "last_rejected_failure_code",
          "last_rejected_backend_version",
          "last_rejected_build_commit_sha"
        )
        VALUES (
          'invalid-rejection-build-commit',
          1,
          '"invalid-build-etag"',
          'invalid-pointer',
          '1.319.0',
          '${"d".repeat(39)}'
        )
      `,
    });

    await client.query(`
      DELETE FROM "connector_catalog_sync_state"
      WHERE "source_id" IN (
        'migration-final-catalog-accepted',
        'migration-final-catalog-rejected'
      )
    `);
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Final connector catalog constraints accept complete state and reject ambiguous state\n",
  );
}

async function expectDeferredDatabaseError(
  client: Client,
  args: {
    readonly code: string;
    readonly messageIncludes?: string;
    readonly statements: readonly {
      readonly query: string;
      readonly values?: readonly string[];
    }[];
  },
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of args.statements) {
      await client.query(
        statement.query,
        statement.values ? [...statement.values] : undefined,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    assert.equal(databaseErrorCode(error), args.code);
    if (args.messageIncludes !== undefined) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(args.messageIncludes));
    }
    return;
  }
  throw new Error(`Expected deferred database error ${args.code}`);
}

async function validateCustomConnectorOauthModeConstraints(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.7: Validate custom connector OAuth mode constraints ===\n",
  );
  const fixture = {
    orgId: "migration-custom-connector-oauth-org",
    createdBy: "migration-custom-connector-oauth-user",
    manualConnectorId: "72000000-0000-4000-8000-000000000001",
    oauthConnectorId: "72000000-0000-4000-8000-000000000002",
    invalidOauthConnectorId: "72000000-0000-4000-8000-000000000003",
  } as const;
  const insertConnector = `
    INSERT INTO "org_custom_connectors" (
      "id",
      "org_id",
      "slug",
      "display_name",
      "prefixes",
      "header_name",
      "header_template",
      "prefix_templates",
      "fields",
      "header_injections",
      "query_injections",
      "auth_mode",
      "created_by"
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      '["https://api.example.test/"]'::jsonb,
      'Authorization',
      'Bearer {{secret}}',
      '["https://api.example.test/"]'::jsonb,
      CASE
        WHEN $5 = 'manual' THEN '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb
        ELSE '[]'::jsonb
      END,
      CASE
        WHEN $5 = 'manual' THEN '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb
        ELSE '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb
      END,
      '[]'::jsonb,
      $5,
      $6
    )
  `;
  const insertOauthConfig = `
    INSERT INTO "org_custom_connector_oauth_configs" (
      "connector_id",
      "org_id",
      "provider_adapter",
      "client_id",
      "encrypted_client_secret",
      "authorization_url",
      "token_url",
      "token_endpoint_auth_method",
      "pkce_method"
    )
    VALUES (
      $1,
      $2,
      'standard',
      'migration-client',
      'migration-encrypted-secret',
      'https://oauth.example.test/authorize',
      'https://oauth.example.test/token',
      'client_secret_basic',
      'none'
    )
  `;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await client.query(insertConnector, [
      fixture.manualConnectorId,
      fixture.orgId,
      "_migration_manual",
      "Migration Manual Connector",
      "manual",
      fixture.createdBy,
    ]);

    await client.query("BEGIN");
    await client.query(insertConnector, [
      fixture.oauthConnectorId,
      fixture.orgId,
      "_migration_oauth",
      "Migration OAuth Connector",
      "oauth",
      fixture.createdBy,
    ]);
    await client.query(insertOauthConfig, [
      fixture.oauthConnectorId,
      fixture.orgId,
    ]);
    await client.query("COMMIT");

    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: insertConnector,
          values: [
            fixture.invalidOauthConnectorId,
            fixture.orgId,
            "_migration_invalid_oauth",
            "Migration Invalid OAuth Connector",
            "oauth",
            fixture.createdBy,
          ],
        },
      ],
    });
    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: insertOauthConfig,
          values: [fixture.manualConnectorId, fixture.orgId],
        },
      ],
    });
    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: `
            UPDATE "org_custom_connectors"
            SET "auth_mode" = 'manual'
            WHERE "id" = $1
          `,
          values: [fixture.oauthConnectorId],
        },
      ],
    });
    await expectDeferredDatabaseError(client, {
      code: "23514",
      messageIncludes:
        "custom connector auth mode and OAuth config do not match",
      statements: [
        {
          query: `
            DELETE FROM "org_custom_connector_oauth_configs"
            WHERE "connector_id" = $1
          `,
          values: [fixture.oauthConnectorId],
        },
      ],
    });

    await client.query(
      `
        DELETE FROM "org_custom_connectors"
        WHERE "id" IN ($1, $2)
      `,
      [fixture.manualConnectorId, fixture.oauthConnectorId],
    );
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Deferred constraints accept complete modes and reject mismatched OAuth configuration\n",
  );
}

async function extractSchemaFromDb(dbUrl: string): Promise<{
  tables: Set<string>;
  columns: Map<string, Set<string>>;
}> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '__drizzle_migrations'
      ORDER BY table_name
    `);

    const tables = new Set<string>(
      tablesResult.rows.map((r) => {
        return r.table_name;
      }),
    );
    const columns = new Map<string, Set<string>>();

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get columns
      const columnsResult = await client.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY column_name
      `,
        [tableName],
      );

      columns.set(
        tableName,
        new Set(
          columnsResult.rows.map((c) => {
            return c.column_name;
          }),
        ),
      );
    }

    return { tables, columns };
  } finally {
    await client.end();
  }
}

interface SnapshotTable {
  name?: string;
  columns?: Record<string, unknown>;
}

function extractSchemaFromSnapshot(snapshotPath: string): {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
} {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
    tables?: Record<string, SnapshotTable>;
  };
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();

  for (const [tableKey, tableData] of Object.entries(snapshot.tables || {})) {
    // Normalize table name: extract actual table name from the key
    // Could be "users" or "public.users", we want just "users"
    const tableName = tableData.name || tableKey.replace(/^public\./, "");
    tables.add(tableName);

    const tableColumns = new Set<string>(Object.keys(tableData.columns || {}));
    columns.set(tableName, tableColumns);
  }

  return { tables, columns };
}

function compareSchemas(
  dbSchema: { tables: Set<string>; columns: Map<string, Set<string>> },
  snapshotSchema: { tables: Set<string>; columns: Map<string, Set<string>> },
  migrationIdx: number,
): { matches: boolean; differences: string[] } {
  const differences: string[] = [];

  // Compare tables
  const dbTables = Array.from(dbSchema.tables).sort();
  const snapshotTables = Array.from(snapshotSchema.tables).sort();

  const missingInSnapshot = dbTables.filter((t) => {
    return !snapshotTables.includes(t);
  });
  const extraInSnapshot = snapshotTables.filter((t) => {
    return !dbTables.includes(t);
  });

  if (missingInSnapshot.length > 0) {
    differences.push(
      `Migration ${migrationIdx}: Tables in DB but not in snapshot: ${missingInSnapshot.join(", ")}`,
    );
  }
  if (extraInSnapshot.length > 0) {
    differences.push(
      `Migration ${migrationIdx}: Tables in snapshot but not in DB: ${extraInSnapshot.join(", ")}`,
    );
  }

  // Compare columns for each table
  for (const tableName of dbTables) {
    if (!snapshotSchema.columns.has(tableName)) continue;

    const dbCols = Array.from(dbSchema.columns.get(tableName) || []).sort();
    const snapshotCols = Array.from(
      snapshotSchema.columns.get(tableName) || [],
    ).sort();

    const missingCols = dbCols.filter((column) => {
      return !snapshotCols.includes(column);
    });
    const extraCols = snapshotCols.filter((c) => {
      return !dbCols.includes(c);
    });

    if (missingCols.length > 0) {
      differences.push(
        `Migration ${migrationIdx}, table ${tableName}: Columns in DB but not in snapshot: ${missingCols.join(", ")}`,
      );
    }
    if (extraCols.length > 0) {
      differences.push(
        `Migration ${migrationIdx}, table ${tableName}: Columns in snapshot but not in DB: ${extraCols.join(", ")}`,
      );
    }
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

async function validateTimestampOrdering(): Promise<void> {
  console.log("=== Phase 0.5: Validate Journal Timestamp Ordering ===\n");

  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{
    idx: number;
    tag: string;
    when: number;
  }>;

  if (entries.length < 2) {
    console.log("   Skipping (fewer than 2 migrations)\n");
    return;
  }

  const violations: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const curr = entries[i]!;
    if (curr.when <= prev.when) {
      const diffMs = prev.when - curr.when;
      const diffDays = (diffMs / (1000 * 60 * 60 * 24)).toFixed(1);
      violations.push(
        `   ${String(prev.idx).padStart(4, "0")} ${prev.tag} (when=${prev.when}) → ` +
          `${String(curr.idx).padStart(4, "0")} ${curr.tag} (when=${curr.when}) — ` +
          `timestamp goes BACKWARDS by ${diffDays} days`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `   ❌ Found ${violations.length} timestamp ordering violation(s):\n`,
    );
    for (const v of violations) {
      console.error(v);
    }
    console.error(
      `\n   Drizzle's migrator only applies migrations whose timestamp`,
    );
    console.error(`   is greater than the last applied migration's timestamp.`);
    console.error(
      `   Out-of-order timestamps cause migrations to be SKIPPED in production.`,
    );
    console.error(`\n   🔧 How to fix:`);
    console.error(
      `      Update the "when" values in meta/_journal.json so that`,
    );
    console.error(
      `      each entry's timestamp is strictly greater than the previous one.`,
    );
    console.error(
      `      For example, set the violating entry's "when" to prev.when + 1.\n`,
    );
    throw new Error("Journal timestamp ordering violation");
  }

  console.log(
    `   ✅ All ${entries.length} migrations have strictly increasing timestamps`,
  );
  console.log();
}

const RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_PREVIOUS_MIGRATION =
  "0809_clean_kronos";
const RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_MIGRATION = "0810_small_sway";

async function addCurrentChatEventPayloadStorage(
  client: Client,
): Promise<void> {
  await client.query(`
    ALTER TABLE "chat_events"
    ADD COLUMN "payload" jsonb
  `);
}

async function addCurrentChatEventAdditiveStorage(
  client: Client,
): Promise<void> {
  await client.query(`
    ALTER TABLE "chat_events"
    ADD COLUMN "active_input_sequence" integer
  `);
  await addCurrentChatEventPayloadStorage(client);
}

async function validateRunEventSequenceNumberRollout(): Promise<void> {
  console.log(
    "=== Validate populated run event sequence expand, switch, and contract rollout ===\n",
  );
  const testDb = "migration_run_event_sequence_number_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "00000000-0000-4000-8000-000000080701";
  const threadId = "00000000-0000-4000-8000-000000080702";
  const historicalRunId = "00000000-0000-4000-8000-000000080703";
  const previousApiRunId = "00000000-0000-4000-8000-000000080704";
  const currentApiRunId = "00000000-0000-4000-8000-000000080705";
  const contractedRunId = "00000000-0000-4000-8000-000000080706";

  const contractionSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0810_small_sway.sql"),
    "utf8",
  );
  assert.ok(contractionSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.equal(
    (
      contractionSql.match(
        /DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_seq_unique"/gu,
      ) ?? []
    ).length,
    1,
  );
  assert.match(
    contractionSql,
    /DROP TRIGGER IF EXISTS "bridge_chat_event_run_event_sequence_number_0807"/u,
  );
  assert.match(
    contractionSql,
    /DROP FUNCTION IF EXISTS "bridge_chat_event_run_event_sequence_number_0807"\(\)/u,
  );
  assert.match(contractionSql, /DROP COLUMN IF EXISTS "sequence_number"/u);
  assert.doesNotMatch(
    contractionSql,
    /CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"/u,
  );
  assert.doesNotMatch(
    contractionSql,
    /"seq_id"|"last_chat_event_seq_id"|"run_event_id"|"chat_events_run_event_seq_unique"/u,
  );

  const schemaSource = await fs.readFile(
    path.join(PACKAGE_DIR, "src/schema/chat-event.ts"),
    "utf8",
  );
  assert.match(
    schemaSource,
    /runEventSequenceNumber: integer\("run_event_sequence_number"\)/u,
  );
  assert.doesNotMatch(
    schemaSource,
    /sequenceNumber: integer\("sequence_number"\)/u,
  );

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'run-event-sequence-test-user',
            'run-event-sequence-test',
            'run-event-sequence-test-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "title"
          )
          VALUES (
            $1,
            'run-event-sequence-test-user',
            $2,
            'run event sequence expansion test'
          )
        `,
        [threadId, composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "seq_id"
          )
          SELECT
            $1,
            $2,
            'output.message',
            "sequence",
            "sequence"
          FROM generate_series(1, 10001) AS "sequence"
        `,
        [threadId, historicalRunId],
      );

      await addCurrentChatEventAdditiveStorage(client);
      const database = drizzle(client);

      const historicalRows = await client.query<{
        mismatches: string;
        rows: string;
      }>(
        `
          SELECT
            count(*)::text AS "rows",
            count(*) FILTER (
              WHERE "run_event_sequence_number"
                IS DISTINCT FROM "sequence_number"
            )::text AS "mismatches"
          FROM "chat_events"
          WHERE "run_id" = $1
        `,
        [historicalRunId],
      );
      assert.deepEqual(historicalRows.rows, [
        { mismatches: "0", rows: "10001" },
      ]);

      const previousApiInsert = await client.query<{
        id: string;
        runEventSequenceNumber: number;
        sequenceNumber: number;
      }>(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 7, 10002)
          ON CONFLICT ("run_id", "sequence_number") DO NOTHING
          RETURNING
            "id",
            "sequence_number" AS "sequenceNumber",
            "run_event_sequence_number" AS "runEventSequenceNumber"
        `,
        [threadId, previousApiRunId],
      );
      assert.equal(previousApiInsert.rows.length, 1);
      assert.deepEqual(
        previousApiInsert.rows.map((row) => {
          return {
            runEventSequenceNumber: row.runEventSequenceNumber,
            sequenceNumber: row.sequenceNumber,
          };
        }),
        [{ runEventSequenceNumber: 7, sequenceNumber: 7 }],
      );

      const currentApiQuery = database
        .insert(chatEvents)
        .values({
          chatThreadId: threadId,
          runId: currentApiRunId,
          eventType: "output.message",
          runEventSequenceNumber: 9,
          seqId: 10003,
        })
        .onConflictDoNothing({
          target: [chatEvents.runId, chatEvents.runEventSequenceNumber],
        })
        .returning({
          sequenceNumber: chatEvents.runEventSequenceNumber,
        });
      const currentApiSql = currentApiQuery.toSQL();
      const currentApiExplanation = await client.query<{
        "QUERY PLAN": unknown;
      }>(`EXPLAIN (FORMAT JSON) ${currentApiSql.sql}`, currentApiSql.params);
      function collectConflictArbiterIndexes(
        value: unknown,
      ): readonly string[] {
        if (Array.isArray(value)) {
          return value.flatMap((item) => {
            return collectConflictArbiterIndexes(item);
          });
        }
        if (typeof value !== "object" || value === null) {
          return [];
        }
        const record = value as Record<string, unknown>;
        const directIndexes = record["Conflict Arbiter Indexes"];
        return [
          ...(Array.isArray(directIndexes)
            ? directIndexes.filter((item): item is string => {
                return typeof item === "string";
              })
            : []),
          ...Object.values(record).flatMap((item) => {
            return collectConflictArbiterIndexes(item);
          }),
        ];
      }
      assert.deepEqual(
        collectConflictArbiterIndexes(
          currentApiExplanation.rows[0]?.["QUERY PLAN"],
        ),
        ["chat_events_run_event_seq_unique"],
      );

      assert.deepEqual(await currentApiQuery, [{ sequenceNumber: 9 }]);
      const mirroredRuntimeWrites = await client.query<{
        legacySequenceNumber: number;
        runEventSequenceNumber: number;
        runId: string;
      }>(
        `
          SELECT
            "run_id" AS "runId",
            "sequence_number" AS "legacySequenceNumber",
            "run_event_sequence_number" AS "runEventSequenceNumber"
          FROM "chat_events"
          WHERE "run_id" IN ($1, $2)
          ORDER BY "run_id"
        `,
        [previousApiRunId, currentApiRunId],
      );
      assert.deepEqual(mirroredRuntimeWrites.rows, [
        {
          legacySequenceNumber: 7,
          runEventSequenceNumber: 7,
          runId: previousApiRunId,
        },
        {
          legacySequenceNumber: 9,
          runEventSequenceNumber: 9,
          runId: currentApiRunId,
        },
      ]);

      const indexes = await client.query<{
        definition: string;
        isUnique: boolean;
        isValid: boolean;
        name: string;
      }>(`
        SELECT
          "index_class"."relname" AS "name",
          "index"."indisunique" AS "isUnique",
          "index"."indisvalid" AS "isValid",
          pg_get_indexdef("index"."indexrelid") AS "definition"
        FROM "pg_index" AS "index"
        INNER JOIN "pg_class" AS "index_class"
          ON "index_class"."oid" = "index"."indexrelid"
        WHERE "index_class"."relname" IN (
          'chat_events_run_seq_unique',
          'chat_events_run_event_seq_unique'
        )
        ORDER BY "index_class"."relname"
      `);
      assert.deepEqual(
        indexes.rows.map((index) => {
          return {
            isUnique: index.isUnique,
            isValid: index.isValid,
            name: index.name,
          };
        }),
        [
          {
            isUnique: true,
            isValid: true,
            name: "chat_events_run_event_seq_unique",
          },
          {
            isUnique: true,
            isValid: true,
            name: "chat_events_run_seq_unique",
          },
        ],
      );
      assert.match(
        indexes.rows[0]?.definition ?? "",
        /\(run_id, run_event_sequence_number\)$/u,
      );
      assert.match(
        indexes.rows[1]?.definition ?? "",
        /\(run_id, sequence_number\)$/u,
      );

      await client.query(`DROP INDEX "chat_events_run_event_seq_unique"`);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_run_seq_unique",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 7, 10004)
        `,
        values: [threadId, previousApiRunId],
      });
      await client.query(`
        CREATE UNIQUE INDEX "chat_events_run_event_seq_unique"
        ON "chat_events" USING btree (
          "run_id",
          "run_event_sequence_number"
        )
      `);

      await client.query(`DROP INDEX "chat_events_run_seq_unique"`);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_run_event_seq_unique",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 9, 10005)
        `,
        values: [threadId, currentApiRunId],
      });
      await client.query(`
        CREATE UNIQUE INDEX "chat_events_run_seq_unique"
        ON "chat_events" USING btree ("run_id", "sequence_number")
      `);

      await expectDatabaseError(client, {
        code: "P0001",
        messageIncludes: "chat event run event sequence columns must match",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "sequence_number",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, gen_random_uuid(), 'output.message', 1, 2, 10006)
        `,
        values: [threadId],
      });

      const previousApiEventId = previousApiInsert.rows[0]?.id;
      assert.ok(previousApiEventId);
      await assertChatEventsAppendOnlyProtection(client, previousApiEventId);
      await expectDatabaseError(client, {
        code: "P0001",
        messageIncludes: "chat_events is append-only; UPDATE is not allowed",
        query: `
          UPDATE "chat_events"
          SET "run_event_sequence_number" = 10
          WHERE "run_id" = $1
        `,
        values: [currentApiRunId],
      });

      const rejectFunction = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(
          'public.reject_chat_event_source_update()'::regprocedure
        ) AS "definition"
      `);
      assert.doesNotMatch(
        rejectFunction.rows[0]?.definition ?? "",
        /run_event_sequence_number/u,
      );
      const strictRejectFunctionDefinition = rejectFunction.rows[0]?.definition;
      assert.ok(strictRejectFunctionDefinition);

      await applyMigrationsUpToTag(
        client,
        RUN_EVENT_SEQUENCE_NUMBER_CONTRACTION_MIGRATION,
      );

      const preservedRows = await client.query<{
        maximumSequence: number;
        minimumSequence: number;
        rows: string;
      }>(
        `
          SELECT
            count(*)::text AS "rows",
            min("run_event_sequence_number") AS "minimumSequence",
            max("run_event_sequence_number") AS "maximumSequence"
          FROM "chat_events"
          WHERE "run_id" = $1
        `,
        [historicalRunId],
      );
      assert.deepEqual(preservedRows.rows, [
        {
          maximumSequence: 10001,
          minimumSequence: 1,
          rows: "10001",
        },
      ]);

      const switchedRows = await client.query<{
        runEventSequenceNumber: number;
        runId: string;
      }>(
        `
          SELECT
            "run_id" AS "runId",
            "run_event_sequence_number" AS "runEventSequenceNumber"
          FROM "chat_events"
          WHERE "run_id" IN ($1, $2)
          ORDER BY "run_id"
        `,
        [previousApiRunId, currentApiRunId],
      );
      assert.deepEqual(switchedRows.rows, [
        {
          runEventSequenceNumber: 7,
          runId: previousApiRunId,
        },
        {
          runEventSequenceNumber: 9,
          runId: currentApiRunId,
        },
      ]);

      const contractedInsert = await database
        .insert(chatEvents)
        .values({
          chatThreadId: threadId,
          runId: contractedRunId,
          eventType: "output.message",
          runEventSequenceNumber: 11,
          seqId: 10007,
        })
        .returning({
          id: chatEvents.id,
          sequenceNumber: chatEvents.runEventSequenceNumber,
        });
      assert.equal(contractedInsert.length, 1);
      assert.equal(contractedInsert[0]?.sequenceNumber, 11);
      const contractedEventId = contractedInsert[0]?.id;
      assert.ok(contractedEventId);

      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_run_event_seq_unique",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, 'output.message', 11, 10008)
        `,
        values: [threadId, contractedRunId],
      });
      await assertChatEventsAppendOnlyProtection(client, contractedEventId);

      const contractionStatements = contractionSql
        .split("--> statement-breakpoint")
        .map((statement) => {
          return statement.trim();
        })
        .filter((statement) => {
          return statement.length > 0;
        });
      for (const statement of contractionStatements) {
        await client.query(statement);
      }

      const contractedCatalog = await client.query<{
        backfillProcedurePresent: boolean;
        bridgeFunctionPresent: boolean;
        bridgeTriggerPresent: boolean;
        canonicalIndexValid: boolean;
        legacyColumnPresent: boolean;
        legacyIndexPresent: boolean;
        rejectTriggerEnabled: string;
      }>(`
        SELECT
          EXISTS (
            SELECT 1
            FROM "information_schema"."columns"
            WHERE "table_schema" = 'public'
              AND "table_name" = 'chat_events'
              AND "column_name" = 'sequence_number'
          ) AS "legacyColumnPresent",
          to_regclass('public.chat_events_run_seq_unique') IS NOT NULL
            AS "legacyIndexPresent",
          EXISTS (
            SELECT 1
            FROM "pg_index"
            WHERE "indexrelid" =
              'public.chat_events_run_event_seq_unique'::regclass
              AND "indisunique"
              AND "indisvalid"
          ) AS "canonicalIndexValid",
          to_regprocedure(
            'public.bridge_chat_event_run_event_sequence_number_0807()'
          ) IS NOT NULL AS "bridgeFunctionPresent",
          to_regprocedure(
            'public.backfill_chat_event_run_event_sequence_number_0807()'
          ) IS NOT NULL AS "backfillProcedurePresent",
          EXISTS (
            SELECT 1
            FROM "pg_trigger"
            WHERE "tgrelid" = 'public.chat_events'::regclass
              AND "tgname" =
                'bridge_chat_event_run_event_sequence_number_0807'
              AND NOT "tgisinternal"
          ) AS "bridgeTriggerPresent",
          (
            SELECT "tgenabled"::text
            FROM "pg_trigger"
            WHERE "tgrelid" = 'public.chat_events'::regclass
              AND "tgname" = 'chat_events_reject_update'
              AND NOT "tgisinternal"
          ) AS "rejectTriggerEnabled"
      `);
      assert.deepEqual(contractedCatalog.rows, [
        {
          backfillProcedurePresent: false,
          bridgeFunctionPresent: false,
          bridgeTriggerPresent: false,
          canonicalIndexValid: true,
          legacyColumnPresent: false,
          legacyIndexPresent: false,
          rejectTriggerEnabled: "O",
        },
      ]);

      const preservedRejectFunction = await client.query<{
        definition: string;
      }>(`
        SELECT pg_get_functiondef(
          'public.reject_chat_event_source_update()'::regprocedure
        ) AS "definition"
      `);
      assert.equal(
        preservedRejectFunction.rows[0]?.definition,
        strictRejectFunctionDefinition,
      );
      await assertChatEventsAppendOnlyProtection(client, contractedEventId);

      console.log("   ✅ 10,001 historical rows backfill across batches");
      console.log(
        "   ✅ Draining legacy and current Drizzle inserts coexist with mirrored columns",
      );
      console.log(
        "   ✅ Current targeted ON CONFLICT resolves to chat_events_run_event_seq_unique",
      );
      console.log("   ✅ Both unique index paths reject duplicates with 23505");
      console.log("   ✅ Strict append-only protection is restored");
      console.log(
        "   ✅ Contract preserves canonical rows and new writes while the canonical index independently rejects duplicates",
      );
      console.log(
        "   ✅ Legacy column, index, bridge, and backfill procedure are absent",
      );
      console.log(
        "   ✅ Contraction non-transactional retries are idempotent\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const GOAL_ONLY_RUN_GROUPS_PREVIOUS_MIGRATION = "0810_small_sway";
const GOAL_ONLY_RUN_GROUPS_MIGRATION = "0811_clear_non_goal_run_groups";

async function validateGoalOnlyRunGroupsCleanup(): Promise<void> {
  console.log("=== Validate goal-only run group cleanup ===\n");
  const testDb = "migration_goal_only_run_groups_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000081001",
    sessionId: "00000000-0000-4000-8000-000000081002",
    threadId: "00000000-0000-4000-8000-000000081003",
    goalId: "00000000-0000-4000-8000-000000081004",
    automationGroupId: "00000000-0000-4000-8000-000000081005",
    workflowRunId: "00000000-0000-4000-8000-000000081006",
    goalRunId: "00000000-0000-4000-8000-000000081007",
    automationEventId: "00000000-0000-4000-8000-000000081008",
    goalEventId: "00000000-0000-4000-8000-000000081009",
    drainingWorkflowRunId: "00000000-0000-4000-8000-000000081010",
    drainingAutomationEventId: "00000000-0000-4000-8000-000000081011",
    orgId: "goal-only-run-groups-org",
    userId: "goal-only-run-groups-user",
  } as const;

  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0811_clear_non_goal_run_groups.sql"),
    "utf8",
  );
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/u);
  assert.doesNotMatch(
    migrationSql,
    /(?:DROP|DISABLE)\s+TRIGGER\s+"chat_events_reject_update"/u,
  );
  assert.equal((migrationSql.match(/\bLIMIT 10000\b/gu) ?? []).length, 2);
  assert.equal(
    (migrationSql.match(/\bFOR UPDATE OF "candidate" SKIP LOCKED\b/gu) ?? [])
      .length,
    2,
  );
  assert.equal((migrationSql.match(/\bCOMMIT\b/gu) ?? []).length, 2);

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      GOAL_ONLY_RUN_GROUPS_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, $2, 'goal-only-run-groups', $3)
        `,
        [fixture.composeId, fixture.userId, fixture.orgId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, $2, $3, 'goal-only-run-groups')
        `,
        [fixture.composeId, fixture.orgId, fixture.userId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" (
            "id",
            "user_id",
            "org_id",
            "agent_compose_id"
          )
          VALUES ($1, $2, $3, $4)
        `,
        [fixture.sessionId, fixture.userId, fixture.orgId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_runs" (
            "id",
            "user_id",
            "session_id",
            "status",
            "prompt",
            "org_id"
          )
          VALUES
            ($1, $3, $4, 'running', 'legacy workflow run', $5),
            ($2, $3, $4, 'running', 'goal continuation run', $5)
        `,
        [
          fixture.workflowRunId,
          fixture.goalRunId,
          fixture.userId,
          fixture.sessionId,
          fixture.orgId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "title"
          )
          VALUES ($1, $2, $3, 'goal-only run groups')
        `,
        [fixture.threadId, fixture.userId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id",
            "org_id",
            "owner_user_id",
            "agent_id",
            "chat_thread_id",
            "status",
            "objective",
            "objective_brief"
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'active',
            'Keep this goal running',
            'Keep this goal running'
          )
        `,
        [
          fixture.goalId,
          fixture.orgId,
          fixture.userId,
          fixture.composeId,
          fixture.threadId,
        ],
      );
      await client.query(
        `
          INSERT INTO "zero_runs" (
            "id",
            "trigger_source",
            "chat_thread_id",
            "run_group_id",
            "goal_id"
          )
          VALUES
            ($1, 'automation-schedule', $3, $4, NULL),
            ($2, 'goal', $3, $5, $5)
        `,
        [
          fixture.workflowRunId,
          fixture.goalRunId,
          fixture.threadId,
          fixture.automationGroupId,
          fixture.goalId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "event_type",
            "content",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES
            ($1, $3, $4, $6, 'output.message', 'workflow result', 1, 1),
            ($2, $3, $5, $7, 'output.message', 'goal result', 1, 2)
        `,
        [
          fixture.automationEventId,
          fixture.goalEventId,
          fixture.threadId,
          fixture.workflowRunId,
          fixture.goalRunId,
          fixture.automationGroupId,
          fixture.goalId,
        ],
      );

      await applyMigrationsUpToTag(client, GOAL_ONLY_RUN_GROUPS_MIGRATION);

      const runGroups = await client.query<{
        id: string;
        runGroupId: string | null;
      }>(
        `
          SELECT "id", "run_group_id" AS "runGroupId"
          FROM "zero_runs"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [fixture.workflowRunId, fixture.goalRunId],
      );
      assert.deepEqual(runGroups.rows, [
        { id: fixture.workflowRunId, runGroupId: null },
        { id: fixture.goalRunId, runGroupId: fixture.goalId },
      ]);

      const eventGroups = await client.query<{
        id: string;
        runGroupId: string | null;
      }>(
        `
          SELECT "id", "run_group_id" AS "runGroupId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [fixture.automationEventId, fixture.goalEventId],
      );
      assert.deepEqual(eventGroups.rows, [
        { id: fixture.automationEventId, runGroupId: null },
        { id: fixture.goalEventId, runGroupId: fixture.goalId },
      ]);

      // Simulate the draining API after migration completion. Its legacy
      // insert shape still sends the automation id as run_group_id to both
      // tables; the compatibility bridges must normalize both writes.
      await client.query(
        `
          INSERT INTO "agent_runs" (
            "id",
            "user_id",
            "session_id",
            "status",
            "prompt",
            "org_id"
          )
          VALUES ($1, $2, $3, 'running', 'draining workflow run', $4)
        `,
        [
          fixture.drainingWorkflowRunId,
          fixture.userId,
          fixture.sessionId,
          fixture.orgId,
        ],
      );
      await client.query(
        `
          INSERT INTO "zero_runs" (
            "id",
            "trigger_source",
            "chat_thread_id",
            "run_group_id",
            "goal_id"
          )
          VALUES ($1, 'automation-event', $2, $3, NULL)
        `,
        [
          fixture.drainingWorkflowRunId,
          fixture.threadId,
          fixture.automationGroupId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "event_type",
            "content",
            "run_event_sequence_number",
            "seq_id"
          )
          VALUES ($1, $2, $3, $4, 'output.message', 'draining result', 1, 3)
        `,
        [
          fixture.drainingAutomationEventId,
          fixture.threadId,
          fixture.drainingWorkflowRunId,
          fixture.automationGroupId,
        ],
      );

      const drainingGroups = await client.query<{
        eventRunGroupId: string | null;
        zeroRunGroupId: string | null;
      }>(
        `
          SELECT
            "event"."run_group_id" AS "eventRunGroupId",
            "run"."run_group_id" AS "zeroRunGroupId"
          FROM "zero_runs" AS "run"
          INNER JOIN "chat_events" AS "event"
            ON "event"."run_id" = "run"."id"
          WHERE "run"."id" = $1
        `,
        [fixture.drainingWorkflowRunId],
      );
      assert.deepEqual(drainingGroups.rows, [
        { eventRunGroupId: null, zeroRunGroupId: null },
      ]);

      const migrationStatements = migrationSql
        .split("--> statement-breakpoint")
        .map((statement) => {
          return statement.trim();
        })
        .filter((statement) => {
          return statement.length > 0;
        });
      for (const statement of migrationStatements) {
        await client.query(statement);
      }

      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.automationEventId,
      );
      const rejectFunction = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(
          'public.reject_chat_event_source_update()'::regprocedure
        ) AS "definition"
      `);
      assert.doesNotMatch(
        rejectFunction.rows[0]?.definition ?? "",
        /run_group_id/u,
      );

      console.log("   ✅ Legacy workflow run groups are cleared");
      console.log("   ✅ Goal continuation run groups are preserved");
      console.log("   ✅ Draining automation writes are normalized");
      console.log(
        "   ✅ Cleanup is batched, retryable, and append-only safe\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateTeamsMessageFileScopeBackfill(): Promise<void> {
  console.log(
    "=== Phase 1.4: Validate Teams message file scope backfill ===\n",
  );
  const testDb = "migration_teams_message_file_scope_test";
  await createDatabase(testDb);
  const testDbUrl = createTestDbUrl(testDb);

  try {
    await runMigrationsUpToTag(testDbUrl, "0815_clammy_wendigo");
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();

    try {
      const composeId = "00000000-0000-4000-8000-000000081301";
      const threadId = "00000000-0000-4000-8000-000000081302";
      const contextId = "00000000-0000-4000-8000-000000081303";
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'teams-file-scope-user', 'teams-file-scope', 'teams-file-scope-org')
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "last_chat_event_seq_id"
          )
          VALUES ($1, 'teams-file-scope-user', $2, 1)
        `,
        [threadId, composeId],
      );

      const legacyMessageFiles = [
        {
          fileId: "teams-current-file",
          sourceId: "current-source",
          name: "current.txt",
          contentType: "text/plain",
          payload: {
            tenantId: "teams-file-scope-tenant",
            url: "https://files.example.test/current.txt",
          },
        },
        {
          fileId: "teams-context-file",
          sourceId: "context-source",
          name: "context.txt",
          contentType: "text/plain",
          payload: {
            tenantId: "teams-file-scope-tenant",
            url: "https://files.example.test/context.txt",
          },
        },
      ];
      await client.query(
        `
          INSERT INTO "chat_teams_context" (
            "id",
            "chat_thread_id",
            "tenant_id",
            "conversation_id",
            "message_files"
          )
          VALUES ($1, $2, 'teams-file-scope-tenant', 'teams-file-scope-conversation', $3::jsonb)
        `,
        [contextId, threadId, JSON.stringify(legacyMessageFiles)],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "event_type",
            "context_type",
            "context_id",
            "trigger_source",
            "user_message",
            "seq_id"
          )
          VALUES ($1, 'input.prompt', 'teams', $2, 'teams', $3::jsonb, 1)
        `,
        [
          threadId,
          contextId,
          JSON.stringify({
            version: 1,
            parts: [
              {
                type: "file",
                fileId: "teams-current-file",
                filenameSnapshot: "current.txt",
                contentType: "text/plain",
              },
              { type: "text", text: "legacy Teams file scope" },
            ],
          }),
        ],
      );

      await applyMigrationsUpToTag(
        client,
        "0816_backfill_teams_message_file_scope",
      );

      const result = await client.query<{ messageFiles: unknown }>(
        `
          SELECT "message_files" AS "messageFiles"
          FROM "chat_teams_context"
          WHERE "id" = $1
        `,
        [contextId],
      );
      assert.deepEqual(result.rows[0]?.messageFiles, [
        { ...legacyMessageFiles[0], inCurrentMessage: true },
        { ...legacyMessageFiles[1], inCurrentMessage: false },
      ]);
      console.log(
        "   ✅ Legacy Teams message files receive exact scope flags\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const INVALIDATED_GOAL_CONTINUATION_PREVIOUS_MIGRATION =
  "0828_migrate_legacy_deepseek_state";
const INVALIDATED_GOAL_CONTINUATION_MIGRATION =
  "0829_revoke_invalidated_goal_continuations";

async function validateInvalidatedGoalContinuationCleanup(): Promise<void> {
  console.log("=== Validate invalidated goal continuation cleanup ===\n");
  const testDb = "migration_invalidated_goal_continuation_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000082801",
    threadId: "00000000-0000-4000-8000-000000082802",
    queuedGoalId: "00000000-0000-4000-8000-000000082803",
    rejectedGoalId: "00000000-0000-4000-8000-000000082804",
    drainingQueuedGoalId: "00000000-0000-4000-8000-000000082805",
    drainingRejectedGoalId: "00000000-0000-4000-8000-000000082806",
    failedQueuedGoalId: "00000000-0000-4000-8000-000000082807",
    failedRejectedGoalId: "00000000-0000-4000-8000-000000082808",
  } as const;
  const invalidationError =
    "Goal continuation no longer matches the active goal";
  const goalMessage = JSON.stringify({
    version: 1,
    parts: [{ type: "goal", goalBrief: "migration fixture" }],
  });

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      INVALIDATED_GOAL_CONTINUATION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'goal-invalidation-user', 'goal-invalidation', 'goal-invalidation-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id",
            "last_chat_event_seq_id"
          )
          VALUES ($1, 'goal-invalidation-user', $2, 2)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "revokes_event_id",
            "event_type",
            "error",
            "user_message",
            "seq_id"
          ) VALUES
            ($1, $3, NULL, 'input.goal', NULL, $5::jsonb, 1),
            ($2, $3, $1, 'input.rejected', $4, $5::jsonb, 2)
        `,
        [
          fixture.queuedGoalId,
          fixture.rejectedGoalId,
          fixture.threadId,
          invalidationError,
          goalMessage,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        INVALIDATED_GOAL_CONTINUATION_MIGRATION,
      );

      const backfilled = await client.query<{
        eventType: string;
        seqId: number;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "seq_id"::int AS "seqId"
          FROM "chat_events"
          WHERE "revokes_event_id" = $1
        `,
        [fixture.rejectedGoalId],
      );
      assert.deepEqual(backfilled.rows, [
        { eventType: "control.revoke", seqId: 3 },
      ]);
      const legacyRejected = await client.query<{
        error: string | null;
        eventType: string;
      }>(
        `
          SELECT "event_type" AS "eventType", "error"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.rejectedGoalId],
      );
      assert.deepEqual(legacyRejected.rows, [
        { eventType: "input.rejected", error: invalidationError },
      ]);
      const thread = await client.query<{ lastSeqId: number }>(
        `
          SELECT "last_chat_event_seq_id"::int AS "lastSeqId"
          FROM "chat_threads"
          WHERE "id" = $1
        `,
        [fixture.threadId],
      );
      assert.deepEqual(thread.rows, [{ lastSeqId: 3 }]);

      await client.query(
        `
          UPDATE "chat_threads"
          SET "last_chat_event_seq_id" = 5
          WHERE "id" = $1
        `,
        [fixture.threadId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "seq_id"
          ) VALUES ($1, $2, 'input.goal', $3::jsonb, 4)
        `,
        [fixture.drainingQueuedGoalId, fixture.threadId, goalMessage],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "revokes_event_id",
            "event_type",
            "error",
            "user_message",
            "seq_id"
          ) VALUES ($1, $2, $3, 'input.rejected', $4, $5::jsonb, 5)
        `,
        [
          fixture.drainingRejectedGoalId,
          fixture.threadId,
          fixture.drainingQueuedGoalId,
          invalidationError,
          goalMessage,
        ],
      );
      await client.query(
        `
          UPDATE "chat_threads"
          SET "last_chat_event_seq_id" = 7
          WHERE "id" = $1
        `,
        [fixture.threadId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "seq_id"
          ) VALUES ($1, $2, 'input.goal', $3::jsonb, 6)
        `,
        [fixture.failedQueuedGoalId, fixture.threadId, goalMessage],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "revokes_event_id",
            "event_type",
            "error",
            "user_message",
            "seq_id"
          ) VALUES (
            $1,
            $2,
            $3,
            'input.rejected',
            'run creation failed',
            $4::jsonb,
            7
          )
        `,
        [
          fixture.failedRejectedGoalId,
          fixture.threadId,
          fixture.failedQueuedGoalId,
          goalMessage,
        ],
      );

      const drainingWrite = await client.query<{
        error: string | null;
        eventType: string;
        userMessage: unknown;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "error",
            "user_message" AS "userMessage"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.drainingRejectedGoalId],
      );
      assert.deepEqual(drainingWrite.rows, [
        { eventType: "control.revoke", error: null, userMessage: null },
      ]);
      const failedWrite = await client.query<{
        error: string | null;
        eventType: string;
        userMessage: unknown;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "error",
            "user_message" AS "userMessage"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.failedRejectedGoalId],
      );
      assert.deepEqual(failedWrite.rows, [
        {
          eventType: "input.rejected",
          error: "run creation failed",
          userMessage: JSON.parse(goalMessage),
        },
      ]);

      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.rejectedGoalId,
      );
      console.log("   ✅ Legacy invalidations receive append-only tombstones");
      console.log("   ✅ Draining API invalidations are normalized on insert");
      console.log("   ✅ Real goal continuation failures remain rejected\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_CONTRACT_CUTOVER_PREVIOUS_MIGRATION =
  "0860_striped_shadow_king";
const CHAT_EVENT_CONTRACT_CUTOVER_MIGRATION =
  "0861_chat_event_contract_cutover";

async function validateChatEventContractCutover(): Promise<void> {
  console.log("=== Validate chat-event contract atomic cutover ===\n");
  const testDb = "migration_chat_event_contract_cutover_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000086101",
    activeThreadId: "00000000-0000-4000-8000-000000086102",
    pausedThreadId: "00000000-0000-4000-8000-000000086103",
    activeGoalId: "00000000-0000-4000-8000-000000086104",
    pausedGoalId: "00000000-0000-4000-8000-000000086105",
    legacyActiveMarkerId: "00000000-0000-4000-8000-000000086106",
    legacyMarkerRevokerId: "00000000-0000-4000-8000-000000086107",
    unrelatedEventId: "00000000-0000-4000-8000-000000086108",
    followupsEventId: "00000000-0000-4000-8000-000000086109",
    followupsRevokerId: "00000000-0000-4000-8000-000000086110",
    legacyPausedMarkerId: "00000000-0000-4000-8000-000000086111",
    historicalRunId: "00000000-0000-4000-8000-000000086112",
  } as const;
  const historicalFollowups = [
    {
      prompt: "Generate a launch page",
      kind: "generate",
      generationType: "website",
    },
    { prompt: "Summarize the result", kind: "talk" },
  ] as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_CONTRACT_CUTOVER_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'contract-cutover-user', 'contract-cutover', 'contract-cutover-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id", "org_id", "owner", "name", "visibility"
          ) VALUES (
            $1,
            'contract-cutover-org',
            'contract-cutover-user',
            'contract-cutover',
            'private'
          )
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "last_chat_event_seq_id"
          ) VALUES
            ($2, 'contract-cutover-user', $1, 5),
            ($3, 'contract-cutover-user', $1, 1)
        `,
        [fixture.composeId, fixture.activeThreadId, fixture.pausedThreadId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id",
            "org_id",
            "owner_user_id",
            "agent_id",
            "chat_thread_id",
            "status",
            "objective",
            "objective_brief"
          ) VALUES
            (
              $4,
              'contract-cutover-org',
              'contract-cutover-user',
              $1,
              $2,
              'active',
              'Current active objective details',
              '  Current active objective  '
            ),
            (
              $5,
              'contract-cutover-org',
              'contract-cutover-user',
              $1,
              $3,
              'paused',
              'Paused objective details',
              'Paused objective'
            )
        `,
        [
          fixture.composeId,
          fixture.activeThreadId,
          fixture.pausedThreadId,
          fixture.activeGoalId,
          fixture.pausedGoalId,
        ],
      );

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "revokes_event_id",
            "event_type",
            "context_type",
            "content",
            "user_message",
            "run_event_sequence_number",
            "run_event_id",
            "goal_event",
            "recommended_followups",
            "seq_id",
            "created_at"
          ) VALUES
            (
              $1, $7, NULL, NULL, NULL, 'goal.changed', NULL, NULL, NULL, NULL, NULL,
              '{"type":"state","status":"active","objectiveBrief":"Historical objective"}'::jsonb,
              NULL, 1, '2026-08-01 12:00:01'
            ),
            (
              $2, $7, NULL, NULL, $1, 'control.revoke', NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, 2, '2026-08-01 12:00:02'
            ),
            (
              $3, $7, NULL, NULL, NULL, 'output.message', NULL, 'Unrelated output', NULL,
              NULL, NULL, NULL, NULL, 3, '2026-08-01 12:00:03'
            ),
            (
              $4, $7, $6, $11, NULL, 'output.followups', NULL, NULL, NULL, 17,
              'followups:historical', NULL, $9::jsonb, 4,
              '2026-08-01 12:00:04'
            ),
            (
              $5, $7, NULL, NULL, $4, 'input.prompt', 'web', NULL,
              '{"version":1,"parts":[{"type":"text","text":"Use the followup"}]}'::jsonb,
              NULL, NULL, NULL, NULL, 5, '2026-08-01 12:00:05'
            ),
            (
              $8, $10, NULL, NULL, NULL, 'goal.changed', NULL, NULL, NULL, NULL, NULL,
              '{"type":"state","status":"paused"}'::jsonb,
              NULL, 1, '2026-08-01 12:00:06'
            )
        `,
        [
          fixture.legacyActiveMarkerId,
          fixture.legacyMarkerRevokerId,
          fixture.unrelatedEventId,
          fixture.followupsEventId,
          fixture.followupsRevokerId,
          fixture.historicalRunId,
          fixture.activeThreadId,
          fixture.legacyPausedMarkerId,
          JSON.stringify(historicalFollowups),
          fixture.pausedThreadId,
          fixture.activeGoalId,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_CONTRACT_CUTOVER_MIGRATION,
      );

      const activeMarkers = await client.query<{
        content: string;
        eventType: string;
        seqId: number;
      }>(
        `
          SELECT
            "event_type" AS "eventType",
            "content",
            "seq_id"::int AS "seqId"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
            AND "event_type" IN ('goal.open', 'goal.close')
          ORDER BY "seq_id"
        `,
        [fixture.activeThreadId],
      );
      assert.deepEqual(activeMarkers.rows, [
        {
          eventType: "goal.open",
          content: "Current active objective",
          seqId: 6,
        },
      ]);
      const pausedMarkers = await client.query<{ count: number }>(
        `
          SELECT count(*)::int AS "count"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
            AND "event_type" IN ('goal.open', 'goal.close')
        `,
        [fixture.pausedThreadId],
      );
      assert.deepEqual(pausedMarkers.rows, [{ count: 0 }]);

      const deletedGoalHistory = await client.query<{ count: number }>(
        `
          SELECT count(*)::int AS "count"
          FROM "chat_events"
          WHERE "id" IN ($1, $2, $3)
        `,
        [
          fixture.legacyActiveMarkerId,
          fixture.legacyMarkerRevokerId,
          fixture.legacyPausedMarkerId,
        ],
      );
      assert.deepEqual(deletedGoalHistory.rows, [{ count: 0 }]);
      const unrelated = await client.query<{ content: string }>(
        `SELECT "content" FROM "chat_events" WHERE "id" = $1`,
        [fixture.unrelatedEventId],
      );
      assert.deepEqual(unrelated.rows, [{ content: "Unrelated output" }]);

      const migratedFollowups = await client.query<{
        content: string;
        createdAt: string;
        id: string;
        recommendedFollowups: unknown;
        runEventId: string;
        runEventSequenceNumber: number;
        runGroupId: string;
        runId: string;
        seqId: number;
        threadId: string;
      }>(
        `
          SELECT
            "id",
            "chat_thread_id" AS "threadId",
            "run_id" AS "runId",
            "run_group_id" AS "runGroupId",
            "content",
            "recommended_followups" AS "recommendedFollowups",
            "run_event_sequence_number" AS "runEventSequenceNumber",
            "run_event_id" AS "runEventId",
            "seq_id"::int AS "seqId",
            to_char("created_at", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
          FROM "chat_events"
          WHERE "id" = $1
        `,
        [fixture.followupsEventId],
      );
      assert.equal(migratedFollowups.rows.length, 1);
      const migratedFollowup = migratedFollowups.rows[0]!;
      assert.deepEqual(
        {
          ...migratedFollowup,
          content: JSON.parse(migratedFollowup.content),
        },
        {
          id: fixture.followupsEventId,
          threadId: fixture.activeThreadId,
          runId: fixture.historicalRunId,
          runGroupId: fixture.activeGoalId,
          content: { version: 1, followups: historicalFollowups },
          recommendedFollowups: null,
          runEventSequenceNumber: 17,
          runEventId: "followups:historical",
          seqId: 4,
          createdAt: "2026-08-01 12:00:04",
        },
      );
      const preservedRevocation = await client.query<{
        revokesEventId: string;
      }>(
        `SELECT "revokes_event_id" AS "revokesEventId" FROM "chat_events" WHERE "id" = $1`,
        [fixture.followupsRevokerId],
      );
      assert.deepEqual(preservedRevocation.rows, [
        { revokesEventId: fixture.followupsEventId },
      ]);

      const eventTypeConstraint = await client.query<{ definition: string }>(`
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `);
      assert.doesNotMatch(
        eventTypeConstraint.rows[0]?.definition ?? "",
        /goal\.changed/u,
      );
      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.followupsEventId,
      );
      console.log("   ✅ active goals received one fresh canonical marker");
      console.log(
        "   ✅ historical goal markers and dependent revokes were deleted",
      );
      console.log("   ✅ followups migrated in place without identity loss");
      console.log("   ✅ the historical cutover constraint is canonical\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_CONTRACTION_PREPARE_PREVIOUS_MIGRATION =
  "0862_first_pepper_potts";
const CHAT_EVENT_CONTRACTION_PREPARE_MIGRATION =
  "0863_prepare_chat_event_contraction";

async function validateChatEventContractionPreparation(): Promise<void> {
  console.log("=== Validate chat-event contraction preparation ===\n");
  const testDb = "migration_chat_event_contraction_prepare_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000086301",
    threadId: "00000000-0000-4000-8000-000000086302",
    startedId: "00000000-0000-4000-8000-000000086303",
    stoppedId: "00000000-0000-4000-8000-000000086304",
    openId: "00000000-0000-4000-8000-000000086305",
    closeId: "00000000-0000-4000-8000-000000086306",
    payloadId: "00000000-0000-4000-8000-000000086307",
    canonicalOpenId: "00000000-0000-4000-8000-000000086308",
    canonicalCloseId: "00000000-0000-4000-8000-000000086309",
    goalOpenId: "00000000-0000-4000-8000-000000086310",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_CONTRACTION_PREPARE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'final-contract-user', 'final-contract', 'final-contract-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id", "org_id", "owner", "name", "visibility"
          ) VALUES (
            $1,
            'final-contract-org',
            'final-contract-user',
            'final-contract',
            'private'
          )
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "last_chat_event_seq_id"
          ) VALUES ($1, 'final-contract-user', $2, 5)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "active_input_sequence",
            "goal_event",
            "attach_files",
            "generation_template",
            "recommended_followups",
            "seq_id"
          ) VALUES
            ($1, $6, 'browser.started', NULL, NULL, NULL, NULL, NULL, 1),
            ($2, $6, 'browser.stopped', NULL, NULL, NULL, NULL, NULL, 2),
            ($3, $6, 'browser.open', NULL, NULL, NULL, NULL, NULL, 3),
            ($4, $6, 'browser.close', NULL, NULL, NULL, NULL, NULL, 4),
            (
              $5,
              $6,
              'output.message',
              7,
              '{"retired":true}'::jsonb,
              '[]'::jsonb,
              '{"retired":true}'::jsonb,
              '[]'::jsonb,
              5
            )
        `,
        [
          fixture.startedId,
          fixture.stoppedId,
          fixture.openId,
          fixture.closeId,
          fixture.payloadId,
          fixture.threadId,
        ],
      );

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_CONTRACTION_PREPARE_MIGRATION,
      );

      const browserEvents = await client.query<{
        eventType: string;
        id: string;
      }>(
        `
          SELECT "id", "event_type" AS "eventType"
          FROM "chat_events"
          WHERE "id" IN ($1, $2, $3, $4)
          ORDER BY "seq_id"
        `,
        [fixture.startedId, fixture.stoppedId, fixture.openId, fixture.closeId],
      );
      assert.deepEqual(browserEvents.rows, [
        { id: fixture.startedId, eventType: "browser.open" },
        { id: fixture.stoppedId, eventType: "browser.close" },
        { id: fixture.openId, eventType: "browser.open" },
        { id: fixture.closeId, eventType: "browser.close" },
      ]);

      const retainedColumns = await client.query<{ columnName: string }>(`
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_events'
          AND "column_name" IN (
            'active_input_sequence',
            'goal_event',
            'attach_files',
            'generation_template',
            'recommended_followups'
          )
        ORDER BY "column_name"
      `);
      assert.deepEqual(retainedColumns.rows, [
        { columnName: "active_input_sequence" },
        { columnName: "attach_files" },
        { columnName: "generation_template" },
        { columnName: "goal_event" },
        { columnName: "recommended_followups" },
      ]);

      // Migration 0863 runs before the Phase 7A API is promoted. Exercise the
      // exact outgoing full-row column set so the currently deployed API stays
      // legal throughout that overlap.
      const outgoingRows = await client.query<{
        row: Record<string, unknown>;
      }>(
        `
          SELECT to_jsonb("outgoing_row") AS "row"
          FROM (
            SELECT
              "id",
              "chat_thread_id",
              "run_id",
              "usage_payload",
              "revokes_event_id",
              "interrupts_run_id",
              "run_group_id",
              "event_type",
              "context_type",
              "context_id",
              "content",
              "user_message",
              "thinking",
              "error",
              "active_input_sequence",
              "run_event_sequence_number",
              "run_event_id",
              "seq_id",
              "goal_event",
              "attach_files",
              "generation_template",
              "recommended_followups",
              "created_at"
            FROM "chat_events"
            WHERE "id" = $1
          ) AS "outgoing_row"
        `,
        [fixture.payloadId],
      );
      const outgoingRow = outgoingRows.rows[0]?.row;
      assert.ok(outgoingRow);
      assert.deepEqual(Object.keys(outgoingRow).sort(), [
        "active_input_sequence",
        "attach_files",
        "chat_thread_id",
        "content",
        "context_id",
        "context_type",
        "created_at",
        "error",
        "event_type",
        "generation_template",
        "goal_event",
        "id",
        "interrupts_run_id",
        "recommended_followups",
        "revokes_event_id",
        "run_event_id",
        "run_event_sequence_number",
        "run_group_id",
        "run_id",
        "seq_id",
        "thinking",
        "usage_payload",
        "user_message",
      ]);
      assert.equal(outgoingRow.active_input_sequence, 7);
      assert.deepEqual(outgoingRow.goal_event, { retired: true });
      assert.deepEqual(outgoingRow.attach_files, []);
      assert.deepEqual(outgoingRow.generation_template, { retired: true });
      assert.deepEqual(outgoingRow.recommended_followups, []);

      const compatibilityObjects = await client.query<{
        functionCount: number;
        indexCount: number;
        triggerCount: number;
      }>(`
        SELECT
          (
            SELECT count(*)::int
            FROM "pg_proc"
            WHERE "proname" IN (
              'canonicalize_legacy_chat_event_insert_0861',
              'is_supported_legacy_followups_0861'
            )
          ) AS "functionCount",
          (
            SELECT count(*)::int
            FROM "pg_indexes"
            WHERE "schemaname" = 'public'
              AND "indexname" = 'chat_events_run_active_input_seq_unique'
          ) AS "indexCount",
          (
            SELECT count(*)::int
            FROM "pg_trigger"
            WHERE "tgname" = 'canonicalize_legacy_chat_event_insert_0861'
              AND NOT "tgisinternal"
          ) AS "triggerCount"
      `);
      assert.deepEqual(compatibilityObjects.rows, [
        { functionCount: 0, indexCount: 1, triggerCount: 0 },
      ]);

      const eventTypeConstraint = await client.query<{ definition: string }>(`
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `);
      const eventTypeDefinition = eventTypeConstraint.rows[0]?.definition ?? "";
      assert.match(eventTypeDefinition, /browser\.open/u);
      assert.match(eventTypeDefinition, /browser\.close/u);
      assert.doesNotMatch(eventTypeDefinition, /browser\.started/u);
      assert.doesNotMatch(eventTypeDefinition, /browser\.stopped/u);

      const canonicalBrowserRows = await client.query<{ eventType: string }>(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "seq_id"
          ) VALUES
            ($1, $3, 'browser.open', 6),
            ($2, $3, 'browser.close', 7)
          RETURNING "event_type" AS "eventType"
        `,
        [fixture.canonicalOpenId, fixture.canonicalCloseId, fixture.threadId],
      );
      assert.deepEqual(canonicalBrowserRows.rows, [
        { eventType: "browser.open" },
        { eventType: "browser.close" },
      ]);

      await assert.rejects(
        client.query(
          `
            INSERT INTO "chat_events" (
              "chat_thread_id", "event_type", "seq_id"
            ) VALUES ($1, 'browser.started', 8)
          `,
          [fixture.threadId],
        ),
        /chat_events_event_type_check/u,
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "content", "seq_id"
          ) VALUES ($1, $2, 'goal.open', 'Canonical objective', 9)
        `,
        [fixture.goalOpenId, fixture.threadId],
      );
      await assert.rejects(
        client.query(
          `
            INSERT INTO "chat_events" (
              "chat_thread_id", "event_type", "content", "error", "seq_id"
            ) VALUES ($1, 'goal.open', 'Invalid marker', 'payload', 10)
          `,
          [fixture.threadId],
        ),
        /chat_events_goal_marker_payload_check/u,
      );
      await assertChatEventsAppendOnlyProtection(client, fixture.startedId);

      console.log("   ✅ retired browser lifecycle rows are canonicalized");
      console.log("   ✅ only browser.open and browser.close remain allowed");
      console.log("   ✅ the drained 0861 insert bridge is absent");
      console.log(
        "   ✅ outgoing ORM columns and active-input index remain compatible",
      );
      console.log("   ✅ strict append-only and goal marker checks remain\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_EVENT_CONTRACTION_FINALIZE_PREVIOUS_MIGRATION =
  "0863_prepare_chat_event_contraction";
const CHAT_EVENT_CONTRACTION_FINALIZE_MIGRATION =
  "0864_finalize_chat_event_contraction";

async function validateChatEventContractionFinalization(): Promise<void> {
  console.log("=== Validate final chat-event contraction ===\n");
  const testDb = "migration_chat_event_contraction_finalize_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000086401",
    threadId: "00000000-0000-4000-8000-000000086402",
    retainedEventId: "00000000-0000-4000-8000-000000086403",
    canonicalGoalId: "00000000-0000-4000-8000-000000086404",
    currentInsertId: "00000000-0000-4000-8000-000000086405",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_EVENT_CONTRACTION_FINALIZE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'finalize-contract-user', 'finalize-contract', 'finalize-contract-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" (
            "id", "org_id", "owner", "name", "visibility"
          ) VALUES (
            $1,
            'finalize-contract-org',
            'finalize-contract-user',
            'finalize-contract',
            'private'
          )
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "agent_compose_id", "last_chat_event_seq_id"
          ) VALUES ($1, 'finalize-contract-user', $2, 4)
        `,
        [fixture.threadId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "content",
            "active_input_sequence",
            "goal_event",
            "attach_files",
            "generation_template",
            "recommended_followups",
            "seq_id"
          ) VALUES (
            $1,
            $2,
            'output.message',
            'Canonical output survives',
            7,
            '{"retired":true}'::jsonb,
            '[]'::jsonb,
            '{"retired":true}'::jsonb,
            '[]'::jsonb,
            1
          )
        `,
        [fixture.retainedEventId, fixture.threadId],
      );

      await applyMigrationsUpToTag(
        client,
        CHAT_EVENT_CONTRACTION_FINALIZE_MIGRATION,
      );

      const retainedRows = await client.query<{
        row: Record<string, unknown>;
      }>(
        `
          SELECT to_jsonb("event") AS "row"
          FROM "chat_events" AS "event"
          WHERE "id" = $1
        `,
        [fixture.retainedEventId],
      );
      const retainedRow = retainedRows.rows[0]?.row;
      assert.ok(retainedRow);
      assert.equal(retainedRow.content, "Canonical output survives");
      assert.deepEqual(Object.keys(retainedRow).sort(), [
        "chat_thread_id",
        "content",
        "context_id",
        "context_type",
        "created_at",
        "error",
        "event_type",
        "id",
        "interrupts_run_id",
        "revokes_event_id",
        "run_event_id",
        "run_event_sequence_number",
        "run_group_id",
        "run_id",
        "seq_id",
        "thinking",
        "usage_payload",
        "user_message",
      ]);

      const finalCatalog = await client.query<{
        columnNames: string[];
        retiredIndex: string | null;
      }>(`
        SELECT
          to_jsonb(ARRAY(
            SELECT "column_name"
            FROM "information_schema"."columns"
            WHERE "table_schema" = 'public'
              AND "table_name" = 'chat_events'
            ORDER BY "column_name"
          )) AS "columnNames",
          to_regclass(
            'public.chat_events_run_active_input_seq_unique'
          )::text AS "retiredIndex"
      `);
      assert.deepEqual(finalCatalog.rows, [
        {
          columnNames: [
            "chat_thread_id",
            "content",
            "context_id",
            "context_type",
            "created_at",
            "error",
            "event_type",
            "id",
            "interrupts_run_id",
            "revokes_event_id",
            "run_event_id",
            "run_event_sequence_number",
            "run_group_id",
            "run_id",
            "seq_id",
            "thinking",
            "usage_payload",
            "user_message",
          ],
          retiredIndex: null,
        },
      ]);

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "content", "seq_id"
          ) VALUES ($1, $2, 'goal.open', 'Canonical objective', 2)
        `,
        [fixture.canonicalGoalId, fixture.threadId],
      );
      await assert.rejects(
        client.query(
          `
            INSERT INTO "chat_events" (
              "chat_thread_id", "event_type", "content", "error", "seq_id"
            ) VALUES ($1, 'goal.open', 'Invalid objective', 'payload', 3)
          `,
          [fixture.threadId],
        ),
        /chat_events_goal_marker_payload_check/u,
      );

      await addCurrentChatEventPayloadStorage(client);
      const database = drizzle(client);
      const currentInsert = database
        .insert(chatEvents)
        .values({
          id: fixture.currentInsertId,
          chatThreadId: fixture.threadId,
          eventType: "output.message",
          content: "Current ORM insert",
          payload: { content: "Current ORM insert" },
          seqId: 4,
        })
        .returning({ id: chatEvents.id });
      const currentInsertSql = currentInsert.toSQL();
      assert.doesNotMatch(
        currentInsertSql.sql,
        /active_input_sequence|goal_event|attach_files|generation_template|recommended_followups/u,
      );
      assert.match(currentInsertSql.sql, /"payload"/u);
      assert.deepEqual(await currentInsert, [{ id: fixture.currentInsertId }]);
      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.retainedEventId,
      );

      console.log("   ✅ retired chat-event columns and index are absent");
      console.log("   ✅ canonical rows and goal-marker checks survive");
      console.log("   ✅ current ORM inserts use only the final column set\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateLatestSnapshotAccuracy(): Promise<void> {
  console.log("=== Phase 1.5: Validate Latest Snapshot Accuracy ===\n");

  const TEST_DB = "migration_snapshot_accuracy_test";

  // Get the latest migration index from journal
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;

  if (entries.length === 0) {
    throw new Error("No migrations found in journal");
  }

  const latestEntry = entries[entries.length - 1];
  if (!latestEntry) {
    throw new Error("Failed to get latest migration entry");
  }

  const latestIdx = latestEntry.idx;

  console.log(`   Validating latest snapshot (migration ${latestIdx})\n`);

  // Create clean test database
  await createDatabase(TEST_DB);
  const dbUrl = createTestDbUrl(TEST_DB);

  try {
    // Apply all migrations
    await runMigrations(dbUrl);

    // Extract schema from database
    const dbSchema = await extractSchemaFromDb(dbUrl);

    // Load latest snapshot
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(latestIdx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshotSchema = extractSchemaFromSnapshot(snapshotPath);

    // Compare
    const { matches, differences } = compareSchemas(
      dbSchema,
      snapshotSchema,
      latestIdx,
    );

    if (matches) {
      console.log(
        `   ✅ Latest snapshot (${latestIdx}) accurately reflects final DB state`,
      );
    } else {
      console.error(
        `   ❌ Latest snapshot (${latestIdx}) does NOT match final DB state:`,
      );
      for (const diff of differences) {
        console.error(`      ${diff}`);
      }
      console.error(`\n   🔧 How to fix:`);
      console.error(`      1. Reset database: pnpm -F @vm0/db db:reset`);
      console.error(
        `      2. Delete the latest migration file (${String(latestIdx).padStart(4, "0")}_*.sql)`,
      );
      console.error(`      3. Remove migration entry from meta/_journal.json`);
      console.error(
        `      4. Delete the latest snapshot (${String(latestIdx).padStart(4, "0")}_snapshot.json)`,
      );
      console.error(`      5. Generate migration: pnpm -F @vm0/db db:generate`);
      console.error(`      6. Apply migration: pnpm -F @vm0/db db:migrate`);
      console.error(
        `\n   ⚠️  IMPORTANT: Never manually write migration files!`,
      );
      console.error(
        `      Always use 'pnpm -F @vm0/db db:generate' to auto-generate migrations.`,
      );
      console.error(
        `      Manual migrations cause snapshot/database mismatches.\n`,
      );
      throw new Error(
        `Latest snapshot ${latestIdx} accuracy validation failed`,
      );
    }
  } finally {
    await dropDatabase(TEST_DB);
  }

  console.log();
}

const CANONICAL_CHAT_EVENT_STORAGE_PREVIOUS_MIGRATION = "0885_mighty_ken_ellis";
const CANONICAL_CHAT_EVENT_STORAGE_MIGRATION =
  "0886_backfill_canonical_chat_event_storage";

async function readCanonicalBackfillDigests(client: Client): Promise<{
  readonly chatEvents: string;
  readonly zeroRuns: string;
}> {
  const digest = async (query: string): Promise<string> => {
    const result = await client.query<{ digest: string }>(query);
    const value = result.rows[0]?.digest;
    if (!value) {
      throw new Error("Canonical backfill digest query returned no row");
    }
    return value;
  };
  return {
    chatEvents: await digest(`
      SELECT md5(COALESCE(
        string_agg(to_jsonb("event")::text, '' ORDER BY "event"."id"),
        ''
      )) AS "digest"
      FROM "chat_events" AS "event"
    `),
    zeroRuns: await digest(`
      SELECT md5(COALESCE(
        string_agg(to_jsonb("run")::text, '' ORDER BY "run"."id"),
        ''
      )) AS "digest"
      FROM "zero_runs" AS "run"
    `),
  };
}

async function validateCanonicalChatEventStorageBackfill(): Promise<void> {
  console.log("=== Validate canonical chat event storage backfill ===\n");
  const testDb = "migration_canonical_chat_event_storage_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000088601",
    threadAId: "00000000-0000-4000-8000-000000088602",
    threadBId: "00000000-0000-4000-8000-000000088603",
    goalAId: "00000000-0000-4000-8000-000000088604",
    goalBId: "00000000-0000-4000-8000-000000088605",
    sessionId: "00000000-0000-4000-8000-000000088606",
    goalZeroRunId: "00000000-0000-4000-8000-000000088607",
    danglingZeroRunId: "00000000-0000-4000-8000-000000088608",
    conflictZeroRunId: "00000000-0000-4000-8000-000000088609",
    multiLeafEventId: "00000000-0000-4000-8000-000000088610",
    userMessageEventId: "00000000-0000-4000-8000-000000088611",
    thinkingEventId: "00000000-0000-4000-8000-000000088612",
    usageEventId: "00000000-0000-4000-8000-000000088613",
    allLeavesEventId: "00000000-0000-4000-8000-000000088614",
    allNullEventId: "00000000-0000-4000-8000-000000088615",
    goalOpenEventId: "00000000-0000-4000-8000-000000088616",
    interruptLegacyEventId: "00000000-0000-4000-8000-000000088617",
    interruptCanonicalEventId: "00000000-0000-4000-8000-000000088618",
    goalOutputEventId: "00000000-0000-4000-8000-000000088619",
    goalInputEventId: "00000000-0000-4000-8000-000000088620",
    goalDanglingEventId: "00000000-0000-4000-8000-000000088621",
    dualWriteEventId: "00000000-0000-4000-8000-000000088622",
    conflictInterruptEventId: "00000000-0000-4000-8000-000000088623",
    conflictContextEventId: "00000000-0000-4000-8000-000000088624",
    concurrentInsertEventId: "00000000-0000-4000-8000-000000088625",
    legacyInterruptRunId: "00000000-0000-4000-8000-000000088630",
    canonicalInterruptRunId: "00000000-0000-4000-8000-000000088631",
    usageRunId: "00000000-0000-4000-8000-000000088632",
    conflictOwnerRunId: "00000000-0000-4000-8000-000000088633",
    duplicateProbeInterruptsRunId: "00000000-0000-4000-8000-000000088634",
    conflictInterruptTargetRunId: "00000000-0000-4000-8000-000000088635",
    missingGoalId: "00000000-0000-4000-8000-000000088636",
    duplicateProbeEventId: "00000000-0000-4000-8000-000000088637",
    conflictContextId: "00000000-0000-4000-8000-000000088638",
  } as const;
  const nestedNullUserMessage = JSON.stringify({
    version: 1,
    parts: [{ type: "text", text: "canonical backfill probe" }],
    compatibilityProbe: { nested: null },
  });
  const goalUserMessage = JSON.stringify({
    version: 1,
    parts: [{ type: "goal", goalBrief: "canonical backfill goal" }],
  });
  const usagePayload = {
    version: 1,
    totalCredits: 2.5,
    settledAt: "2026-08-01T00:00:00.000Z",
    breakdown: [
      {
        kind: "run",
        credits: 2.5,
        providers: [{ provider: "pi", credits: 2.5 }],
      },
    ],
  };

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CANONICAL_CHAT_EVENT_STORAGE_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'canonical-backfill-user', 'canonical-backfill', 'canonical-backfill-org')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, 'canonical-backfill-org', 'canonical-backfill-user', 'canonical-backfill')
        `,
        [fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" ("id", "user_id", "org_id", "agent_compose_id")
          VALUES ($1, 'canonical-backfill-user', 'canonical-backfill-org', $2)
        `,
        [fixture.sessionId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_runs" ("id", "user_id", "session_id", "status", "prompt", "org_id")
          VALUES
            ($1, 'canonical-backfill-user', $4, 'completed', 'goal continuation run', 'canonical-backfill-org'),
            ($2, 'canonical-backfill-user', $4, 'completed', 'dangling goal run', 'canonical-backfill-org'),
            ($3, 'canonical-backfill-user', $4, 'completed', 'conflicting goal run', 'canonical-backfill-org')
        `,
        [
          fixture.goalZeroRunId,
          fixture.danglingZeroRunId,
          fixture.conflictZeroRunId,
          fixture.sessionId,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" ("id", "user_id", "agent_compose_id", "title", "last_chat_event_seq_id")
          VALUES
            ($1, 'canonical-backfill-user', $3, 'canonical backfill thread A', 100),
            ($2, 'canonical-backfill-user', $3, 'canonical backfill thread B', 100)
        `,
        [fixture.threadAId, fixture.threadBId, fixture.composeId],
      );
      await client.query(
        `
          INSERT INTO "thread_goals" (
            "id", "org_id", "owner_user_id", "agent_id", "chat_thread_id",
            "status", "objective", "objective_brief"
          )
          VALUES
            ($1, 'canonical-backfill-org', 'canonical-backfill-user', $3, $4, 'active', 'Goal A objective', 'Goal A'),
            ($2, 'canonical-backfill-org', 'canonical-backfill-user', $3, $5, 'active', 'Goal B objective', 'Goal B')
        `,
        [
          fixture.goalAId,
          fixture.goalBId,
          fixture.composeId,
          fixture.threadAId,
          fixture.threadBId,
        ],
      );

      // Legacy chat_events written before the dual-write release: payload,
      // canonical interrupt run_id, and goal context_id are still absent.
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "usage_payload", "interrupts_run_id",
            "run_group_id", "event_type", "payload", "context_type", "context_id",
            "content", "user_message", "thinking", "error", "seq_id"
          )
          VALUES
            ($1, $14, NULL, NULL, NULL, NULL, 'output.error', NULL, NULL, NULL,
              'output failed', NULL, NULL, 'output error', 1),
            ($2, $14, NULL, NULL, NULL, NULL, 'input.prompt', NULL, 'web', NULL,
              NULL, $16::jsonb, NULL, NULL, 2),
            ($3, $14, NULL, NULL, NULL, NULL, 'output.thinking', NULL, NULL, NULL,
              NULL, NULL, 'legacy thinking', NULL, 3),
            ($4, $14, $12, $18::jsonb, NULL, NULL, 'usage.recorded', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 4),
            ($5, $14, NULL, $18::jsonb, NULL, NULL, 'output.message', NULL, NULL, NULL,
              'all leaves', $16::jsonb, 'all leaves thinking', 'all leaves error', 5),
            ($6, $14, NULL, NULL, NULL, NULL, 'browser.open', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 6),
            ($7, $14, NULL, NULL, NULL, NULL, 'goal.open', NULL, NULL, NULL,
              'Goal A objective', NULL, NULL, NULL, 7),
            ($8, $14, NULL, NULL, $10, NULL, 'control.interrupt', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 8),
            ($9, $14, $11, NULL, $11, NULL, 'control.interrupt', NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, 9),
            ($13, $14, NULL, NULL, NULL, $19, 'output.message', NULL, NULL, NULL,
              'goal result', NULL, NULL, NULL, 10),
            ($20, $14, NULL, NULL, NULL, $19, 'input.goal', NULL, 'goal', NULL,
              NULL, $17::jsonb, NULL, NULL, 11),
            ($21, $15, NULL, NULL, NULL, $22, 'output.message', NULL, NULL, NULL,
              'dangling goal result', NULL, NULL, NULL, 1)
        `,
        [
          fixture.multiLeafEventId,
          fixture.userMessageEventId,
          fixture.thinkingEventId,
          fixture.usageEventId,
          fixture.allLeavesEventId,
          fixture.allNullEventId,
          fixture.goalOpenEventId,
          fixture.interruptLegacyEventId,
          fixture.interruptCanonicalEventId,
          fixture.legacyInterruptRunId,
          fixture.canonicalInterruptRunId,
          fixture.usageRunId,
          fixture.goalOutputEventId,
          fixture.threadAId,
          fixture.threadBId,
          nestedNullUserMessage,
          goalUserMessage,
          JSON.stringify(usagePayload),
          fixture.goalAId,
          fixture.goalInputEventId,
          fixture.goalDanglingEventId,
          fixture.goalBId,
        ],
      );
      // A row the dual-write release already stored canonically must survive
      // the backfill byte-for-byte.
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "event_type", "payload", "content", "seq_id"
          )
          VALUES ($1, $2, 'output.message', $3::jsonb, 'dual write result', 12)
        `,
        [
          fixture.dualWriteEventId,
          fixture.threadAId,
          JSON.stringify({ content: "dual write result" }),
        ],
      );

      // Pre-dual-write zero_runs rows predate the goal-only bridge trigger,
      // which now forces run_group_id := goal_id on every write. Disable it
      // while seeding that historical shape.
      await client.query(
        `ALTER TABLE "zero_runs" DISABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );
      await client.query(
        `
          INSERT INTO "zero_runs" ("id", "trigger_source", "chat_thread_id", "run_group_id", "goal_id")
          VALUES
            ($1, 'goal', $3, $4, NULL),
            ($2, 'goal', $3, $5, NULL)
        `,
        [
          fixture.goalZeroRunId,
          fixture.danglingZeroRunId,
          fixture.threadAId,
          fixture.goalAId,
          fixture.missingGoalId,
        ],
      );
      await client.query(
        `ALTER TABLE "zero_runs" ENABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );

      const dualWriteBefore = await client.query<{ row: unknown }>(
        `SELECT to_jsonb("chat_events") AS "row" FROM "chat_events" WHERE "id" = $1`,
        [fixture.dualWriteEventId],
      );

      // Conflicting canonical values must abort the migration before any
      // mutation, one explicit diagnostic per conflict family.
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "interrupts_run_id", "event_type", "seq_id"
          )
          VALUES ($1, $2, $3, $4, 'control.interrupt', 21)
        `,
        [
          fixture.conflictInterruptEventId,
          fixture.threadAId,
          fixture.conflictOwnerRunId,
          fixture.conflictInterruptTargetRunId,
        ],
      );
      await assert.rejects(
        applyMigrationsUpToTag(client, CANONICAL_CHAT_EVENT_STORAGE_MIGRATION),
        /control\.interrupt rows whose run_id conflicts with interrupts_run_id/u,
      );
      await client.query(`DELETE FROM "chat_events" WHERE "id" = $1`, [
        fixture.conflictInterruptEventId,
      ]);

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_group_id", "event_type", "context_type",
            "context_id", "content", "seq_id"
          )
          VALUES ($1, $2, $3, 'output.message', 'teams', $4, 'conflicting context', 20)
        `,
        [
          fixture.conflictContextEventId,
          fixture.threadAId,
          fixture.goalAId,
          fixture.conflictContextId,
        ],
      );
      await assert.rejects(
        applyMigrationsUpToTag(client, CANONICAL_CHAT_EVENT_STORAGE_MIGRATION),
        /goal-grouped rows whose context conflicts with run_group_id/u,
      );
      await client.query(`DELETE FROM "chat_events" WHERE "id" = $1`, [
        fixture.conflictContextEventId,
      ]);

      await client.query(
        `ALTER TABLE "zero_runs" DISABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );
      await client.query(
        `
          INSERT INTO "zero_runs" ("id", "trigger_source", "chat_thread_id", "run_group_id", "goal_id")
          VALUES ($1, 'goal', $2, $3, $4)
        `,
        [
          fixture.conflictZeroRunId,
          fixture.threadAId,
          fixture.goalAId,
          fixture.goalBId,
        ],
      );
      await client.query(
        `ALTER TABLE "zero_runs" ENABLE TRIGGER "bridge_goal_only_zero_run_group_0810"`,
      );
      await assert.rejects(
        applyMigrationsUpToTag(client, CANONICAL_CHAT_EVENT_STORAGE_MIGRATION),
        /zero_runs has .* rows whose goal_id conflicts with run_group_id/u,
      );
      await client.query(`DELETE FROM "zero_runs" WHERE "id" = $1`, [
        fixture.conflictZeroRunId,
      ]);

      // Goal B disappears the way production goals do; its chat event keeps a
      // dangling run_group_id that the backfill must still canonicalize.
      await client.query(`DELETE FROM "thread_goals" WHERE "id" = $1`, [
        fixture.goalBId,
      ]);

      // One eligible row stays locked by a concurrent writer while the
      // migration runs; the same transaction also appends a dual-write-shaped
      // row mid-flight. FOR UPDATE SKIP LOCKED plus the restart pass must
      // catch the locked row after commit and leave the new row untouched.
      const lockClient = new Client({ connectionString: testDbUrl });
      await lockClient.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(
          `SELECT 1 FROM "chat_events" WHERE "id" = $1 FOR UPDATE`,
          [fixture.userMessageEventId],
        );
        await lockClient.query(
          `
            INSERT INTO "chat_events" (
              "id", "chat_thread_id", "event_type", "payload", "content", "seq_id"
            )
            VALUES ($1, $2, 'output.message', $3::jsonb, 'concurrent dual write', 90)
          `,
          [
            fixture.concurrentInsertEventId,
            fixture.threadBId,
            JSON.stringify({ content: "concurrent dual write" }),
          ],
        );
        const migrated = applyMigrationsUpToTag(
          client,
          CANONICAL_CHAT_EVENT_STORAGE_MIGRATION,
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 600);
        });
        await lockClient.query("COMMIT");
        await migrated;
      } finally {
        await lockClient.end();
      }

      const canonicalRows = await client.query<{
        id: string;
        payload: unknown;
        runId: string | null;
        interruptsRunId: string | null;
        runGroupId: string | null;
        contextType: string | null;
        contextId: string | null;
      }>(
        `
          SELECT
            "id",
            "payload",
            "run_id" AS "runId",
            "interrupts_run_id" AS "interruptsRunId",
            "run_group_id" AS "runGroupId",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" = ANY($1::uuid[])
          ORDER BY "id"
        `,
        [
          [
            fixture.multiLeafEventId,
            fixture.userMessageEventId,
            fixture.thinkingEventId,
            fixture.usageEventId,
            fixture.allLeavesEventId,
            fixture.allNullEventId,
            fixture.goalOpenEventId,
            fixture.interruptLegacyEventId,
            fixture.interruptCanonicalEventId,
            fixture.goalOutputEventId,
            fixture.goalInputEventId,
            fixture.goalDanglingEventId,
            fixture.concurrentInsertEventId,
          ],
        ],
      );
      const canonicalRow = (id: string) => {
        const row = canonicalRows.rows.find((candidate) => {
          return candidate.id === id;
        });
        if (!row) {
          throw new Error(`Missing canonical backfill fixture row ${id}`);
        }
        return row;
      };

      assert.deepEqual(canonicalRow(fixture.multiLeafEventId).payload, {
        content: "output failed",
        error: "output error",
      });
      const backfilledUserMessage = canonicalRow(fixture.userMessageEventId);
      assert.deepEqual(backfilledUserMessage.payload, {
        userMessage: JSON.parse(nestedNullUserMessage),
      });
      const probedPayload = backfilledUserMessage.payload as {
        userMessage: { compatibilityProbe: { nested: unknown } };
      };
      assert.equal(probedPayload.userMessage.compatibilityProbe.nested, null);
      assert.deepEqual(canonicalRow(fixture.thinkingEventId).payload, {
        thinking: "legacy thinking",
      });
      assert.deepEqual(canonicalRow(fixture.usageEventId).payload, {
        usage: usagePayload,
      });
      assert.deepEqual(canonicalRow(fixture.allLeavesEventId).payload, {
        content: "all leaves",
        userMessage: JSON.parse(nestedNullUserMessage),
        thinking: "all leaves thinking",
        error: "all leaves error",
        usage: usagePayload,
      });
      assert.equal(canonicalRow(fixture.allNullEventId).payload, null);
      assert.deepEqual(canonicalRow(fixture.goalOpenEventId).payload, {
        content: "Goal A objective",
      });
      assert.deepEqual(canonicalRow(fixture.interruptLegacyEventId), {
        id: fixture.interruptLegacyEventId,
        payload: null,
        runId: fixture.legacyInterruptRunId,
        interruptsRunId: fixture.legacyInterruptRunId,
        runGroupId: null,
        contextType: null,
        contextId: null,
      });
      assert.deepEqual(canonicalRow(fixture.interruptCanonicalEventId), {
        id: fixture.interruptCanonicalEventId,
        payload: null,
        runId: fixture.canonicalInterruptRunId,
        interruptsRunId: fixture.canonicalInterruptRunId,
        runGroupId: null,
        contextType: null,
        contextId: null,
      });
      assert.deepEqual(canonicalRow(fixture.goalOutputEventId), {
        id: fixture.goalOutputEventId,
        payload: { content: "goal result" },
        runId: null,
        interruptsRunId: null,
        runGroupId: fixture.goalAId,
        contextType: "goal",
        contextId: fixture.goalAId,
      });
      assert.deepEqual(canonicalRow(fixture.goalInputEventId), {
        id: fixture.goalInputEventId,
        payload: { userMessage: JSON.parse(goalUserMessage) },
        runId: null,
        interruptsRunId: null,
        runGroupId: fixture.goalAId,
        contextType: "goal",
        contextId: fixture.goalAId,
      });
      assert.deepEqual(canonicalRow(fixture.goalDanglingEventId), {
        id: fixture.goalDanglingEventId,
        payload: { content: "dangling goal result" },
        runId: null,
        interruptsRunId: null,
        runGroupId: fixture.goalBId,
        contextType: "goal",
        contextId: fixture.goalBId,
      });
      assert.deepEqual(canonicalRow(fixture.concurrentInsertEventId).payload, {
        content: "concurrent dual write",
      });
      assert.equal(
        canonicalRow(fixture.concurrentInsertEventId).contextType,
        null,
      );

      const dualWriteAfter = await client.query<{ row: unknown }>(
        `SELECT to_jsonb("chat_events") AS "row" FROM "chat_events" WHERE "id" = $1`,
        [fixture.dualWriteEventId],
      );
      assert.deepEqual(dualWriteAfter.rows, dualWriteBefore.rows);

      const zeroRunRows = await client.query<{
        id: string;
        runGroupId: string | null;
        goalId: string | null;
      }>(
        `
          SELECT "id", "run_group_id" AS "runGroupId", "goal_id" AS "goalId"
          FROM "zero_runs"
          WHERE "id" = ANY($1::uuid[])
          ORDER BY "id"
        `,
        [[fixture.goalZeroRunId, fixture.danglingZeroRunId]],
      );
      assert.deepEqual(zeroRunRows.rows, [
        {
          id: fixture.goalZeroRunId,
          runGroupId: fixture.goalAId,
          goalId: fixture.goalAId,
        },
        {
          id: fixture.danglingZeroRunId,
          runGroupId: fixture.missingGoalId,
          goalId: null,
        },
      ]);

      const canonicalInterruptIndex = await client.query<{
        indexdef: string;
      }>(`
        SELECT "indexdef"
        FROM "pg_indexes"
        WHERE "tablename" = 'chat_events'
          AND "indexname" = 'chat_events_control_interrupt_run_id_unique'
      `);
      assert.equal(canonicalInterruptIndex.rows.length, 1);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "chat_events_control_interrupt_run_id_unique",
        query: `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "interrupts_run_id", "event_type", "seq_id"
          )
          VALUES ($1, $2, $3, $4, 'control.interrupt', 95)
        `,
        values: [
          fixture.duplicateProbeEventId,
          fixture.threadAId,
          fixture.legacyInterruptRunId,
          fixture.duplicateProbeInterruptsRunId,
        ],
      });

      await assertChatEventsAppendOnlyProtection(
        client,
        fixture.multiLeafEventId,
      );
      // The narrowed canonicalization window must be closed again: even the
      // no-op canonical image is rejected once the strict trigger is back.
      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `UPDATE "chat_events" SET "payload" = "payload" WHERE "id" = $1`,
        rowId: fixture.multiLeafEventId,
      });

      // Rerunning the finished migration must be a no-op: the batches find no
      // eligible rows and every assertion still holds.
      const digestsBeforeRerun = await readCanonicalBackfillDigests(client);
      const migrationSql = await fs.readFile(
        path.join(
          MIGRATIONS_DIR,
          `${CANONICAL_CHAT_EVENT_STORAGE_MIGRATION}.sql`,
        ),
        "utf-8",
      );
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim().length === 0) {
          continue;
        }
        await client.query(statement);
      }
      assert.deepEqual(
        await readCanonicalBackfillDigests(client),
        digestsBeforeRerun,
      );
      console.log(
        "   ✅ Canonical chat event storage backfill converges, aborts on conflicts, and reruns cleanly\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CHAT_RUN_SERVICE_TIER_PREVIOUS_MIGRATION = "0889_thankful_crusher_hogan";
const CHAT_RUN_SERVICE_TIER_MIGRATION =
  "0893_backfill_chat_run_service_tier_annotations";

const CHAT_RUN_SERVICE_TIER_FIXTURE = {
  composeId: "00000000-0000-4000-8000-000000089001",
  sessionId: "00000000-0000-4000-8000-000000089002",
  affectedThreadId: "00000000-0000-4000-8000-000000089003",
  unaffectedThreadId: "00000000-0000-4000-8000-000000089004",
  tailThreadId: "00000000-0000-4000-8000-000000089005",
  fastRunId: "00000000-0000-4000-8000-000000089006",
  annotatedFastRunId: "00000000-0000-4000-8000-000000089007",
  standardRunId: "00000000-0000-4000-8000-000000089008",
  modelLessFastRunId: "00000000-0000-4000-8000-000000089009",
  tailFastRunId: "00000000-0000-4000-8000-000000089010",
  fastEventId: "00000000-0000-4000-8000-000000089011",
  annotatedFastEventId: "00000000-0000-4000-8000-000000089012",
  standardEventId: "00000000-0000-4000-8000-000000089013",
  modelLessFastEventId: "00000000-0000-4000-8000-000000089014",
  tailFastEventId: "00000000-0000-4000-8000-000000089015",
  tailPrefixEventId: "00000000-0000-4000-8000-000000089016",
  affectedSnapshotId: "00000000-0000-4000-8000-000000089021",
  unaffectedSnapshotId: "00000000-0000-4000-8000-000000089022",
  tailSnapshotId: "00000000-0000-4000-8000-000000089023",
  concurrentSnapshotId: "00000000-0000-4000-8000-000000089024",
  staleTailSnapshotId: "00000000-0000-4000-8000-000000089025",
  orgId: "chat-run-service-tier-org",
  userId: "chat-run-service-tier-user",
} as const;

const CHAT_RUN_SERVICE_TIER_MESSAGES = {
  fast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run" },
      { type: "model", selectedModel: "gpt-5.6-sol" },
    ],
  },
  expectedFast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run" },
      {
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      },
    ],
  },
  annotatedFast: {
    version: 1,
    parts: [
      { type: "text", text: "already annotated fast run" },
      {
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      },
    ],
  },
  standard: {
    version: 1,
    parts: [
      { type: "text", text: "standard run" },
      { type: "model", selectedModel: "gpt-5.6-sol" },
    ],
  },
  modelLessFast: {
    version: 1,
    parts: [{ type: "text", text: "fast run without a model part" }],
  },
  tailFast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run in the postgres tail" },
      { type: "model", selectedModel: "gpt-5.6-sol" },
    ],
  },
  expectedTailFast: {
    version: 1,
    parts: [
      { type: "text", text: "fast run in the postgres tail" },
      {
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      },
    ],
  },
} as const;

function assertChatRunServiceTierMigrationShape(migrationSql: string): void {
  assert.ok(migrationSql.startsWith(NON_TRANSACTIONAL_MIGRATION_MARKER));
  assert.doesNotMatch(migrationSql, /\bLOCK\s+TABLE\b/u);
  assert.doesNotMatch(
    migrationSql,
    /(?:DROP|DISABLE)\s+TRIGGER\s+"chat_events_reject_update"/u,
  );
  assert.equal((migrationSql.match(/\bLIMIT 500\b/gu) ?? []).length, 1);
  assert.equal(
    (migrationSql.match(/\bFOR UPDATE OF "candidate" SKIP LOCKED\b/gu) ?? [])
      .length,
    1,
  );
  assert.equal((migrationSql.match(/\bCOMMIT\b/gu) ?? []).length, 1);
  assert.match(
    migrationSql,
    /SET "user_message" =[\s\S]*"payload" = jsonb_set/u,
  );
  assert.equal(
    (migrationSql.match(/"chat_thread_id" = ANY\(updated_thread_ids\)/gu) ?? [])
      .length,
    2,
  );
  assert.doesNotMatch(migrationSql, /updated_seq_ids/u);
}

async function seedChatRunServiceTierOwners(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'chat-run-service-tier', $3)
    `,
    [fixture.composeId, fixture.userId, fixture.orgId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_compose_id"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [fixture.sessionId, fixture.userId, fixture.orgId, fixture.composeId],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" (
        "id",
        "user_id",
        "agent_compose_id",
        "title",
        "last_chat_event_seq_id"
      )
      VALUES
        ($1, $4, $5, 'affected snapshot', 2),
        ($2, $4, $5, 'unaffected snapshot', 2),
        ($3, $4, $5, 'postgres tail snapshot', 2)
    `,
    [
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
      fixture.userId,
      fixture.composeId,
    ],
  );
}

async function seedChatRunServiceTierRuns(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id"
      )
      VALUES
        ($1, $6, $7, 'running', 'fast run', $8),
        ($2, $6, $7, 'running', 'annotated fast run', $8),
        ($3, $6, $7, 'running', 'standard run', $8),
        ($4, $6, $7, 'running', 'model-less fast run', $8),
        ($5, $6, $7, 'running', 'tail fast run', $8)
    `,
    [
      fixture.fastRunId,
      fixture.annotatedFastRunId,
      fixture.standardRunId,
      fixture.modelLessFastRunId,
      fixture.tailFastRunId,
      fixture.userId,
      fixture.sessionId,
      fixture.orgId,
    ],
  );
  await client.query(
    `
      INSERT INTO "zero_runs" (
        "id", "trigger_source", "selected_model", "codex_service_tier",
        "chat_thread_id"
      )
      VALUES
        ($1, 'web', 'gpt-5.6-sol', 'fast', $6),
        ($2, 'web', 'gpt-5.6-sol', 'fast', $6),
        ($3, 'web', 'gpt-5.6-sol', NULL, $7),
        ($4, 'web', 'gpt-5.6-sol', 'fast', $7),
        ($5, 'web', 'gpt-5.6-sol', 'fast', $8)
    `,
    [
      fixture.fastRunId,
      fixture.annotatedFastRunId,
      fixture.standardRunId,
      fixture.modelLessFastRunId,
      fixture.tailFastRunId,
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
    ],
  );
}

async function seedChatRunServiceTierEvents(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const messages = CHAT_RUN_SERVICE_TIER_MESSAGES;
  await client.query(
    `
      INSERT INTO "chat_events" (
        "id", "chat_thread_id", "run_id", "event_type", "context_type",
        "payload", "user_message", "seq_id"
      )
      VALUES
        ($1, $7, $10, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $15::jsonb), $15::jsonb, 1),
        ($2, $7, $11, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $16::jsonb), $16::jsonb, 2),
        ($3, $8, $12, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $17::jsonb), $17::jsonb, 1),
        ($4, $8, $13, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $18::jsonb), $18::jsonb, 2),
        ($5, $9, NULL, 'output.message', NULL, NULL, NULL, 1),
        ($6, $9, $14, 'input.prompt', 'web',
          jsonb_build_object('userMessage', $19::jsonb), $19::jsonb, 2)
    `,
    [
      fixture.fastEventId,
      fixture.annotatedFastEventId,
      fixture.standardEventId,
      fixture.modelLessFastEventId,
      fixture.tailPrefixEventId,
      fixture.tailFastEventId,
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
      fixture.fastRunId,
      fixture.annotatedFastRunId,
      fixture.standardRunId,
      fixture.modelLessFastRunId,
      fixture.tailFastRunId,
      JSON.stringify(messages.fast),
      JSON.stringify(messages.annotatedFast),
      JSON.stringify(messages.standard),
      JSON.stringify(messages.modelLessFast),
      JSON.stringify(messages.tailFast),
    ],
  );
}

async function seedChatRunServiceTierSnapshots(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  await client.query(
    `
      INSERT INTO "chat_event_snapshots" (
        "id", "chat_thread_id", "last_seq_id", "archive_schema_version",
        "object_key", "is_head"
      )
      VALUES
        ($1, $4, 2, 3, 'migration/affected.ndjson.gz', true),
        ($2, $5, 2, 3, 'migration/unaffected.ndjson.gz', true),
        ($3, $6, 1, 3, 'migration/tail.ndjson.gz', true)
    `,
    [
      fixture.affectedSnapshotId,
      fixture.unaffectedSnapshotId,
      fixture.tailSnapshotId,
      fixture.affectedThreadId,
      fixture.unaffectedThreadId,
      fixture.tailThreadId,
    ],
  );
}

async function seedChatRunServiceTierFixture(client: Client): Promise<void> {
  await seedChatRunServiceTierOwners(client);
  await seedChatRunServiceTierRuns(client);
  await seedChatRunServiceTierEvents(client);
  await seedChatRunServiceTierSnapshots(client);
}

async function waitForPostgresBlock(
  observer: Client,
  blockedPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `
        SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS "blocked"
      `,
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) {
      return;
    }
    await observer.query(`SELECT pg_sleep(0.01)`);
  }
  assert.fail("migration did not wait for the concurrent snapshot publisher");
}

async function databaseBackendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    `SELECT pg_backend_pid() AS "pid"`,
  );
  const pid = result.rows[0]?.pid;
  assert.ok(pid);
  return pid;
}

async function applyBackfillWhileSnapshotPublisherWins(
  client: Client,
  testDbUrl: string,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const messages = CHAT_RUN_SERVICE_TIER_MESSAGES;
  const publisher = new Client({ connectionString: testDbUrl });
  await publisher.connect();
  let transactionOpen = false;
  try {
    // The production publisher reads event bytes before opening its short
    // expected-parent swap transaction. Capture that stale candidate from a
    // head which does not cover the event that 0893 will update.
    const staleTailCandidate = await publisher.query<{
      archiveSchemaVersion: number;
      canonicalUserMessage: unknown;
      lastSeqId: string;
      objectKey: string;
    }>(
      `
        SELECT
          "snapshot"."archive_schema_version" AS "archiveSchemaVersion",
          "event"."payload" -> 'userMessage' AS "canonicalUserMessage",
          "snapshot"."last_seq_id" AS "lastSeqId",
          "snapshot"."object_key" AS "objectKey"
        FROM "chat_event_snapshots" AS "snapshot"
        INNER JOIN "chat_events" AS "event"
          ON "event"."chat_thread_id" = "snapshot"."chat_thread_id"
        WHERE "snapshot"."id" = $1
          AND "snapshot"."is_head"
          AND "event"."id" = $2
      `,
      [fixture.tailSnapshotId, fixture.tailFastEventId],
    );
    assert.deepEqual(staleTailCandidate.rows, [
      {
        archiveSchemaVersion: 3,
        canonicalUserMessage: messages.tailFast,
        lastSeqId: "1",
        objectKey: "migration/tail.ndjson.gz",
      },
    ]);

    const migrationPid = await databaseBackendPid(client);
    const publisherPid = await databaseBackendPid(publisher);
    await publisher.query("BEGIN");
    transactionOpen = true;
    const demoted = await publisher.query(
      `
        UPDATE "chat_event_snapshots"
        SET "is_head" = false
        WHERE "id" = $1 AND "is_head"
        RETURNING "id"
      `,
      [fixture.affectedSnapshotId],
    );
    assert.equal(demoted.rowCount, 1);
    await publisher.query(
      `
        INSERT INTO "chat_event_snapshots" (
          "id", "chat_thread_id", "parent_snapshot_id", "last_seq_id",
          "archive_schema_version", "object_key", "is_head"
        )
        VALUES ($1, $2, $3, 2, 3, 'migration/concurrent.ndjson.gz', true)
      `,
      [
        fixture.concurrentSnapshotId,
        fixture.affectedThreadId,
        fixture.affectedSnapshotId,
      ],
    );

    const migrationPromise = applyMigrationsUpToTag(
      client,
      CHAT_RUN_SERVICE_TIER_MIGRATION,
    );
    try {
      await waitForPostgresBlock(publisher, migrationPid, publisherPid);
      await publisher.query("COMMIT");
      transactionOpen = false;
      await migrationPromise;

      // Complete the stale publisher's short CAS after the migration commits.
      // 0893 must have demoted its shorter expected parent, otherwise this
      // would publish a current v4 head containing the old event bytes above.
      await publisher.query("BEGIN");
      transactionOpen = true;
      const staleTailParent = staleTailCandidate.rows[0];
      assert.ok(staleTailParent);
      const staleTailDemoted = await publisher.query(
        `
          UPDATE "chat_event_snapshots"
          SET "is_head" = false
          WHERE "id" = $1
            AND "chat_thread_id" = $2
            AND "is_head"
            AND "archive_schema_version" = $3
            AND "last_seq_id" = $4
            AND "object_key" = $5
          RETURNING "id"
        `,
        [
          fixture.tailSnapshotId,
          fixture.tailThreadId,
          staleTailParent.archiveSchemaVersion,
          staleTailParent.lastSeqId,
          staleTailParent.objectKey,
        ],
      );
      if (staleTailDemoted.rowCount === 1) {
        await publisher.query(
          `
            INSERT INTO "chat_event_snapshots" (
              "id", "chat_thread_id", "parent_snapshot_id", "last_seq_id",
              "archive_schema_version", "object_key", "is_head"
            )
            VALUES ($1, $2, $3, 2, 4, 'migration/stale-tail.ndjson.gz', true)
          `,
          [
            fixture.staleTailSnapshotId,
            fixture.tailThreadId,
            fixture.tailSnapshotId,
          ],
        );
      }
      await publisher.query("COMMIT");
      transactionOpen = false;
      assert.equal(staleTailDemoted.rowCount, 0);
    } catch (error) {
      if (transactionOpen) {
        await publisher.query("ROLLBACK");
        transactionOpen = false;
      }
      await migrationPromise.catch(() => {
        return undefined;
      });
      throw error;
    }
  } finally {
    if (transactionOpen) {
      await publisher.query("ROLLBACK");
    }
    await publisher.end();
  }
}

async function chatEventsRejectFunctionDefinition(
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

async function assertChatRunServiceTierMessages(client: Client): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const messages = CHAT_RUN_SERVICE_TIER_MESSAGES;
  const result = await client.query<{
    id: string;
    canonicalUserMessage: unknown;
    legacyUserMessage: unknown;
  }>(
    `
      SELECT
        "id",
        "payload" -> 'userMessage' AS "canonicalUserMessage",
        "user_message" AS "legacyUserMessage"
      FROM "chat_events"
      WHERE "id" IN ($1, $2, $3, $4, $5)
      ORDER BY "id"
    `,
    [
      fixture.fastEventId,
      fixture.annotatedFastEventId,
      fixture.standardEventId,
      fixture.modelLessFastEventId,
      fixture.tailFastEventId,
    ],
  );
  assert.deepEqual(result.rows, [
    {
      id: fixture.fastEventId,
      canonicalUserMessage: messages.expectedFast,
      legacyUserMessage: messages.expectedFast,
    },
    {
      id: fixture.annotatedFastEventId,
      canonicalUserMessage: messages.annotatedFast,
      legacyUserMessage: messages.annotatedFast,
    },
    {
      id: fixture.standardEventId,
      canonicalUserMessage: messages.standard,
      legacyUserMessage: messages.standard,
    },
    {
      id: fixture.modelLessFastEventId,
      canonicalUserMessage: messages.modelLessFast,
      legacyUserMessage: messages.modelLessFast,
    },
    {
      id: fixture.tailFastEventId,
      canonicalUserMessage: messages.expectedTailFast,
      legacyUserMessage: messages.expectedTailFast,
    },
  ]);
}

async function assertChatRunServiceTierSnapshotHeads(
  client: Client,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const result = await client.query<{ id: string; isHead: boolean }>(
    `
      SELECT "id", "is_head" AS "isHead"
      FROM "chat_event_snapshots"
      WHERE "id" IN ($1, $2, $3, $4, $5)
      ORDER BY "id"
    `,
    [
      fixture.affectedSnapshotId,
      fixture.unaffectedSnapshotId,
      fixture.tailSnapshotId,
      fixture.concurrentSnapshotId,
      fixture.staleTailSnapshotId,
    ],
  );
  assert.deepEqual(result.rows, [
    { id: fixture.affectedSnapshotId, isHead: false },
    { id: fixture.unaffectedSnapshotId, isHead: true },
    { id: fixture.tailSnapshotId, isHead: false },
    { id: fixture.concurrentSnapshotId, isHead: false },
  ]);
}

async function assertChatRunServiceTierMigrationCleanup(
  client: Client,
  strictRejectFunctionDefinition: string,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const artifacts = await client.query<{
    annotationFunctionPresent: boolean;
    backfillProcedurePresent: boolean;
  }>(`
    SELECT
      to_regprocedure(
        'public.annotate_chat_event_priority_0893(jsonb)'
      ) IS NOT NULL AS "annotationFunctionPresent",
      to_regprocedure(
        'public.backfill_chat_run_service_tier_annotations_0893()'
      ) IS NOT NULL AS "backfillProcedurePresent"
  `);
  assert.deepEqual(artifacts.rows, [
    { annotationFunctionPresent: false, backfillProcedurePresent: false },
  ]);
  assert.equal(
    await chatEventsRejectFunctionDefinition(client),
    strictRejectFunctionDefinition,
  );
  await assertChatEventsAppendOnlyProtection(client, fixture.fastEventId);
}

async function rerunChatRunServiceTierMigration(
  client: Client,
  migrationSql: string,
): Promise<void> {
  const fixture = CHAT_RUN_SERVICE_TIER_FIXTURE;
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  for (const statement of statements) {
    await client.query(statement);
  }
  const remaining = await client.query<{ count: string }>(`
    SELECT count(*)::text AS "count"
    FROM "chat_events" AS "event"
    INNER JOIN "zero_runs" AS "run" ON "run"."id" = "event"."run_id"
    WHERE "run"."codex_service_tier" = 'fast'
      AND (
        "event"."payload" -> 'userMessage'
          IS DISTINCT FROM "event"."user_message"
        OR (
          jsonb_typeof(
            "event"."payload" -> 'userMessage' -> 'parts'
          ) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              "event"."payload" -> 'userMessage' -> 'parts'
            ) AS "part"
            WHERE "part" ->> 'type' = 'model'
              AND "part" ->> 'serviceTier' IS DISTINCT FROM 'priority'
          )
        )
      )
  `);
  assert.deepEqual(remaining.rows, [{ count: "0" }]);
  await assertChatEventsAppendOnlyProtection(client, fixture.fastEventId);
}

async function validateChatRunServiceTierAnnotationBackfill(): Promise<void> {
  console.log("=== Validate chat-run service tier annotation backfill ===\n");
  const testDb = "migration_chat_run_service_tier_annotation_test";
  const testDbUrl = createTestDbUrl(testDb);
  const migrationSql = await fs.readFile(
    path.join(
      MIGRATIONS_DIR,
      "0893_backfill_chat_run_service_tier_annotations.sql",
    ),
    "utf8",
  );
  assertChatRunServiceTierMigrationShape(migrationSql);

  await createDatabase(testDb);
  try {
    await runMigrationsUpToTag(
      testDbUrl,
      CHAT_RUN_SERVICE_TIER_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await seedChatRunServiceTierFixture(client);

      const strictRejectFunctionDefinition =
        await chatEventsRejectFunctionDefinition(client);

      await applyBackfillWhileSnapshotPublisherWins(client, testDbUrl);

      await assertChatRunServiceTierMessages(client);

      await assertChatRunServiceTierSnapshotHeads(client);

      await assertChatRunServiceTierMigrationCleanup(
        client,
        strictRejectFunctionDefinition,
      );
      await rerunChatRunServiceTierMigration(client, migrationSql);

      console.log("   ✅ proven fast runs receive priority annotations");
      console.log("   ✅ standard and model-less messages remain unchanged");
      console.log(
        "   ✅ a concurrently published covering snapshot head is demoted",
      );
      console.log(
        "   ✅ a stale publisher cannot extend a non-covering snapshot head",
      );
      console.log(
        "   ✅ backfill is batched, retryable, and restores append-only protection\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const USAGE_PACK_REFUND_SCHEMA_MIGRATION = "0898_usage_pack_credit_refunds";
const USAGE_PACK_INVITE_BACKFILL_MIGRATION =
  "0899_backfill_member_invite_usage_pack_required";
const USAGE_PACK_CHANGE_INDEX_MIGRATION =
  "0900_replace_scheduled_usage_pack_change";

async function validateUsagePackInviteLifecycleMigrations(): Promise<void> {
  console.log("=== Validate usage-pack invite lifecycle migrations ===\n");
  const testDb = "migration_usage_pack_invite_lifecycle_test";
  const testDbUrl = createTestDbUrl(testDb);
  await createDatabase(testDb);

  try {
    await runMigrationsUpToTag(testDbUrl, USAGE_PACK_REFUND_SCHEMA_MIGRATION);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();

    try {
      await client.query(`
        INSERT INTO "org_plan_entitlements" (
          "org_id",
          "plan_key",
          "plan_rank",
          "source",
          "stripe_subscription_id"
        )
        VALUES
          ('org_usage_pack_active_pro', 'pro', 1, 'stripe', 'sub_active_pro'),
          ('org_usage_pack_active_team', 'team', 2, 'stripe', 'sub_active_team'),
          ('org_usage_pack_free', 'limited-free-1', 0, 'stripe', 'sub_free'),
          ('org_usage_pack_canceled', 'pro', 1, 'stripe', 'sub_canceled'),
          ('org_usage_pack_expired', 'team', 2, 'stripe', 'sub_expired'),
          ('org_usage_pack_invalid', 'pro', 1, 'stripe', 'sub_invalid'),
          ('org_usage_pack_mismatch', 'pro', 1, 'stripe', 'sub_entitlement')
      `);
      await client.query(`
        INSERT INTO "usage_pack_subscriptions" (
          "id",
          "org_id",
          "tier",
          "stripe_plan_price_id",
          "stripe_customer_id",
          "stripe_subscription_id",
          "subscription_status"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000090001',
            'org_usage_pack_active_pro',
            'pro',
            'price_plan_pro',
            'cus_active_pro',
            'sub_active_pro',
            'active'
          ),
          (
            '00000000-0000-4000-8000-000000090002',
            'org_usage_pack_active_team',
            'team',
            'price_plan_team',
            'cus_active_team',
            'sub_active_team',
            'trialing'
          ),
          (
            '00000000-0000-4000-8000-000000090003',
            'org_usage_pack_free',
            'pro',
            'price_plan_pro',
            'cus_free',
            'sub_free',
            'active'
          ),
          (
            '00000000-0000-4000-8000-000000090004',
            'org_usage_pack_canceled',
            'pro',
            'price_plan_pro',
            'cus_canceled',
            'sub_canceled',
            'canceled'
          ),
          (
            '00000000-0000-4000-8000-000000090005',
            'org_usage_pack_expired',
            'team',
            'price_plan_team',
            'cus_expired',
            'sub_expired',
            'incomplete_expired'
          ),
          (
            '00000000-0000-4000-8000-000000090006',
            'org_usage_pack_invalid',
            'pro',
            'price_plan_pro',
            'cus_invalid',
            'sub_invalid',
            'invalid'
          ),
          (
            '00000000-0000-4000-8000-000000090007',
            'org_usage_pack_mismatch',
            'pro',
            'price_plan_pro',
            'cus_mismatch',
            'sub_usage_pack',
            'active'
          )
      `);

      await applyMigrationsUpToTag(
        client,
        USAGE_PACK_INVITE_BACKFILL_MIGRATION,
      );
      const entitlements = await client.query<{
        memberInviteUsagePackRequired: boolean;
        orgId: string;
      }>(`
        SELECT
          "org_id" AS "orgId",
          "member_invite_usage_pack_required" AS "memberInviteUsagePackRequired"
        FROM "org_plan_entitlements"
        WHERE "org_id" LIKE 'org_usage_pack_%'
        ORDER BY "org_id"
      `);
      assert.deepEqual(entitlements.rows, [
        {
          memberInviteUsagePackRequired: true,
          orgId: "org_usage_pack_active_pro",
        },
        {
          memberInviteUsagePackRequired: true,
          orgId: "org_usage_pack_active_team",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_canceled",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_expired",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_free",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_invalid",
        },
        {
          memberInviteUsagePackRequired: false,
          orgId: "org_usage_pack_mismatch",
        },
      ]);

      await client.query(`
        INSERT INTO "usage_pack_subscription_changes" (
          "id",
          "usage_pack_subscription_id",
          "org_id",
          "source_tier",
          "target_tier",
          "status",
          "proration_timestamp",
          "immediate_amount_cents",
          "next_recurring_amount_cents",
          "currency",
          "preview_expires_at",
          "effective_at"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000090011',
            '00000000-0000-4000-8000-000000090001',
            'org_usage_pack_active_pro',
            'pro',
            'pro',
            'completed',
            1,
            0,
            0,
            'usd',
            '2035-01-01',
            '2035-02-01'
          ),
          (
            '00000000-0000-4000-8000-000000090012',
            '00000000-0000-4000-8000-000000090001',
            'org_usage_pack_active_pro',
            'pro',
            'pro',
            'completed',
            2,
            0,
            0,
            'usd',
            '2035-01-01',
            '2035-02-01'
          )
      `);
      await applyMigrationsUpToTag(client, USAGE_PACK_CHANGE_INDEX_MIGRATION);

      await client.query(`
        INSERT INTO "usage_pack_allocation_changes" (
          "id",
          "usage_pack_subscription_id",
          "subscription_change_id",
          "org_id",
          "user_id",
          "kind",
          "status",
          "target_usage_pack_usd",
          "target_stripe_price_id"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000090021',
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090011',
            'org_usage_pack_active_pro',
            'user_grouped_preview',
            'addition',
            'previewed',
            20,
            'price_usage_pack_20'
          ),
          (
            '00000000-0000-4000-8000-000000090022',
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090012',
            'org_usage_pack_active_pro',
            'user_grouped_preview',
            'addition',
            'previewed',
            50,
            'price_usage_pack_50'
          ),
          (
            '00000000-0000-4000-8000-000000090023',
            '00000000-0000-4000-8000-000000090001',
            NULL,
            'org_usage_pack_active_pro',
            'user_grouped_preview',
            'addition',
            'previewed',
            100,
            'price_usage_pack_100'
          ),
          (
            '00000000-0000-4000-8000-000000090024',
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090011',
            'org_usage_pack_active_pro',
            'user_scheduled',
            'addition',
            'scheduled',
            20,
            'price_usage_pack_20'
          )
      `);
      await expectDatabaseError(client, {
        code: "23505",
        messageIncludes: "uq_usage_pack_changes_current_user",
        query: `
          INSERT INTO "usage_pack_allocation_changes" (
            "usage_pack_subscription_id",
            "subscription_change_id",
            "org_id",
            "user_id",
            "kind",
            "status",
            "target_usage_pack_usd",
            "target_stripe_price_id"
          )
          VALUES (
            '00000000-0000-4000-8000-000000090001',
            '00000000-0000-4000-8000-000000090012',
            'org_usage_pack_active_pro',
            'user_scheduled',
            'addition',
            'scheduled',
            50,
            'price_usage_pack_50'
          )
        `,
      });

      console.log(
        "   ✅ Active Pro and Team usage-pack subscriptions require invite packages",
      );
      console.log(
        "   ✅ Terminal, free, and mismatched subscriptions remain unchanged",
      );
      console.log(
        "   ✅ Grouped previews coexist while scheduled replacements remain unique\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function main(): Promise<void> {
  console.log("🧪 Testing Migration Consistency (Schema Comparison)\n");

  const TEST_DB_1 = "migration_test_existing";
  const TEST_DB_2 = "migration_test_generated";
  let migrationsBackedUp = false;

  try {
    // Step 0: Validate snapshot files
    await validateSnapshotFiles();

    // Step 0.1: Validate transition validators use migration tags
    await validateMigrationTagReferences();

    // Step 0.5: Validate timestamp ordering
    await validateTimestampOrdering();

    await validateRunEventSequenceNumberRollout();
    await validateGoalOnlyRunGroupsCleanup();
    await validateTeamsMessageFileScopeBackfill();
    await validateInvalidatedGoalContinuationCleanup();
    await validateMcpCustomConnectorReaderPreparation();
    await validateCustomCredentialStorageGenerationBackfill();
    await validateChatEventContractCutover();
    await validateChatEventContractionPreparation();
    await validateChatEventContractionFinalization();
    await validateCanonicalChatEventStorageBackfill();
    await validateChatRunServiceTierAnnotationBackfill();
    await validateUsagePackInviteLifecycleMigrations();

    // Step 1.5: Validate latest snapshot accuracy (NEW)
    await validateLatestSnapshotAccuracy();

    // Step 1: Test with existing migrations
    console.log("=== Phase 2: Test existing migrations ===\n");
    await createDatabase(TEST_DB_1);
    const dbUrl1 = createTestDbUrl(TEST_DB_1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Migrations applied successfully\n");

    console.log("=== Phase 2.1: Validate database reset ===\n");
    await resetDatabase(dbUrl1);
    await resetDatabase(dbUrl1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Consecutive database resets completed successfully\n");

    await validatePermanentTriggerAndFunctionInventory(dbUrl1);
    await validatePermanentArtifactTriggerBehavior(dbUrl1);
    await validateExpandedBrowserSchema(dbUrl1);
    await validateChatEventSourcesAreAppendOnly(dbUrl1);
    await validateChatEventContextPointerConstraints(dbUrl1);
    await validateConnectorCatalogFinalConstraints(dbUrl1);
    await validateCustomConnectorOauthModeConstraints(dbUrl1);

    // Step 2: Backup and regenerate migrations
    console.log("=== Phase 3: Test regenerated migrations ===\n");
    await backupMigrations();
    migrationsBackedUp = true;
    await generateFreshMigrations();

    // Step 3: Test with regenerated migrations
    await createDatabase(TEST_DB_2);
    const dbUrl2 = createTestDbUrl(TEST_DB_2);
    await runMigrations(dbUrl2);
    console.log("   ✅ Fresh migrations applied successfully\n");

    // Step 4: Restore original migrations
    await restoreMigrations();
    migrationsBackedUp = false;

    // Step 5: Run normalized comparison (using pg library)
    console.log("=== Phase 4: Normalized schema comparison ===\n");
    const comparisonPassed = await runNormalizedComparison(dbUrl1, dbUrl2);

    if (comparisonPassed) {
      console.log("\n✅ SUCCESS: All validations passed!");
      console.log("   ✅ Snapshot count matches migration count");
      console.log("   ✅ Snapshot chain is intact (id/prevId references)");
      console.log("   ✅ Journal timestamps are strictly increasing");
      console.log("   ✅ Latest snapshot accurately reflects final DB state");
      console.log(
        "   ✅ Browser state uses canonical thread identity and lifecycle events",
      );
      console.log("   ✅ Chat event source tables reject UPDATE");
      console.log(
        "   ✅ Final connector catalog constraints reject invalid state",
      );
      console.log(
        "   ✅ Custom connector OAuth mode constraints reject mismatched configuration",
      );
      console.log("   ✅ Legacy Teams message file scope is backfilled");
      console.log(
        "   ✅ Zero-run Codex tier readers survive the pre-expansion schema",
      );
      console.log("   ✅ Permanent trigger and function inventories match");
      console.log(
        "   ✅ Permanent artifact triggers preserve cascade, queue, and scope behavior",
      );
      console.log("   ✅ Consecutive database resets replay all migrations");
      console.log("   ✅ Schemas are functionally equivalent");
      console.log("   ✅ All migrations match the schema definitions");

      // Cleanup
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);

      process.exit(0);
    } else {
      console.log("\n❌ FAILURE: Schemas have functional differences!");
      console.log(
        `\n   This means the migration files don't match the schema definitions.`,
      );
      console.log(`\n   💡 Databases preserved for analysis:`);
      console.log(`      ${TEST_DB_1}`);
      console.log(`      ${TEST_DB_2}`);
      console.log(`\n   For detailed analysis, run:`);
      console.log(
        `     pnpm -F @vm0/db exec tsx scripts/compare-schemas-normalized.ts "<${TEST_DB_1}-url>" "<${TEST_DB_2}-url>"`,
      );
      console.log(`\n   🔧 How to fix:`);
      console.log(`      1. Check if you manually edited any migration files`);
      console.log(`      2. Reset database: pnpm -F @vm0/db db:reset`);
      console.log(`      3. Delete the problematic migration files`);
      console.log(
        `      4. Remove corresponding entries from meta/_journal.json`,
      );
      console.log(`      5. Delete corresponding snapshots`);
      console.log(`      6. Regenerate: pnpm -F @vm0/db db:generate`);
      console.log(`      7. Apply: pnpm -F @vm0/db db:migrate`);
      console.log(
        `\n   ⚠️  IMPORTANT: Never manually write or edit migration files!`,
      );
      console.log(
        `      Always use 'pnpm -F @vm0/db db:generate' to auto-generate migrations.`,
      );
      console.log(
        `      Manual edits break the snapshot system and cause schema mismatches.\n`,
      );

      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Error during test:", error);

    // Try to cleanup
    try {
      if (migrationsBackedUp) {
        await restoreMigrations();
      }
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);
    } catch (cleanupError) {
      console.error("⚠️  Failed to cleanup:", cleanupError);
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
