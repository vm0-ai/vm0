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
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { connectorExternalCodeSessions } from "../src/schema/connector-external-code-session";
import { connectorOauthDeviceAuthorizationSessions } from "../src/schema/connector-oauth-device-authorization-session";
import { connectorOauthStates } from "../src/schema/connector-oauth-state";
import { connectors } from "../src/schema/connector";
import { chatEvents } from "../src/schema/chat-event";
import { chatThreads } from "../src/schema/chat-thread";
import { userConnectors } from "../src/schema/user-connector";
import { userPermissionGrants } from "../src/schema/user-permission-grant";
import { zeroRuns } from "../src/schema/zero-run";

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

async function validateCurrentBrowserApiBeforeBillingMigration(): Promise<void> {
  console.log(
    "=== Phase 1.95: Validate current browser API before billing migration ===\n",
  );
  const testDb = "migration_current_browser_api_pre_billing_test";
  const testDbUrl = createTestDbUrl(testDb);
  const agentComposeId = "00000000-0000-4000-8000-000000073301";
  const agentSessionId = "00000000-0000-4000-8000-000000073302";
  const runId = "00000000-0000-4000-8000-000000073303";
  const browserProfileId = "00000000-0000-4000-8000-000000073304";
  const providerProfileId = "00000000-0000-4000-8000-000000073305";
  const browserThreadProfileId = "00000000-0000-4000-8000-000000073306";
  const threadProviderProfileId = "00000000-0000-4000-8000-000000073307";
  const browserSessionId = "00000000-0000-4000-8000-000000073308";
  const providerSessionId = "00000000-0000-4000-8000-000000073309";
  const chatThreadId = "00000000-0000-4000-8000-000000073310";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 733);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();

    try {
      const legacyDefaults = await client.query<{
        columnDefault: string | null;
        columnName: string;
        tableName: string;
      }>(
        `
          SELECT
            "table_name" AS "tableName",
            "column_name" AS "columnName",
            "column_default" AS "columnDefault"
          FROM "information_schema"."columns"
          WHERE (
            "table_name" = 'browser_sessions'
            AND "column_name" = 'max_credits'
          ) OR (
            "table_name" = 'browser_session_instances'
            AND "column_name" IN ('pricing_unit_price', 'pricing_unit_size')
          )
        `,
      );
      assert.equal(legacyDefaults.rows.length, 3);
      for (const column of legacyDefaults.rows) {
        assert.equal(
          column.columnDefault,
          null,
          `${column.tableName}.${column.columnName} unexpectedly has a pre-0734 default`,
        );
      }

      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'browser-current-user',
            'current-browser-api-pre-migration',
            'browser-current-org'
          )
        `,
        [agentComposeId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" (
            "id",
            "user_id",
            "org_id",
            "agent_compose_id"
          )
          VALUES (
            $1,
            'browser-current-user',
            'browser-current-org',
            $2
          )
        `,
        [agentSessionId, agentComposeId],
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
          VALUES (
            $1,
            'browser-current-user',
            $2,
            'running',
            'browser migration compatibility test',
            'browser-current-org'
          )
        `,
        [runId, agentSessionId],
      );
      await client.query(
        `
          INSERT INTO "browser_profiles" (
            "id",
            "org_id",
            "user_id",
            "provider_profile_id"
          )
          VALUES (
            $1,
            'browser-current-org',
            'browser-current-user',
            $2
          )
        `,
        [browserProfileId, providerProfileId],
      );
      await client.query(
        `
          INSERT INTO "browser_thread_profiles" (
            "id",
            "chat_thread_id",
            "org_id",
            "user_id",
            "provider_profile_id"
          )
          VALUES (
            $1,
            $2,
            'browser-current-org',
            'browser-current-user',
            $3
          )
        `,
        [browserThreadProfileId, chatThreadId, threadProviderProfileId],
      );

      // These are the current API's transitional statement shapes. The three
      // legacy billing columns are explicit because migration 0734 has not run.
      const browser = await client.query<{ maxCredits: number }>(
        `
          INSERT INTO "browser_sessions" (
            "id",
            "chat_thread_id",
            "run_id",
            "org_id",
            "user_id",
            "name",
            "browser_profile_id",
            "browser_thread_profile_id",
            "status",
            "proxy_country_code",
            "timeout_minutes",
            "max_credits"
          )
          VALUES (
            $1,
            $2,
            $3,
            'browser-current-org',
            'browser-current-user',
            'current-api-start',
            $4,
            $5,
            'creating',
            NULL,
            240,
            1
          )
          RETURNING "max_credits" AS "maxCredits"
        `,
        [
          browserSessionId,
          chatThreadId,
          runId,
          browserProfileId,
          browserThreadProfileId,
        ],
      );
      assert.deepEqual(browser.rows, [{ maxCredits: 1 }]);

      const instance = await client.query<{
        pricingUnitPrice: string;
        pricingUnitSize: string;
      }>(
        `
          INSERT INTO "browser_session_instances" (
            "provider_session_id",
            "browser_session_id",
            "chat_thread_id",
            "run_id",
            "status",
            "pricing_unit_price",
            "pricing_unit_size",
            "timeout_at",
            "started_at",
            "last_touched_at",
            "idle_expires_at",
            "stop_requested_at",
            "finished_at"
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'active',
            0,
            1,
            now() + interval '240 minutes',
            now(),
            now(),
            now() + interval '10 minutes',
            NULL,
            NULL
          )
          RETURNING
            "pricing_unit_price"::text AS "pricingUnitPrice",
            "pricing_unit_size"::text AS "pricingUnitSize"
        `,
        [providerSessionId, browserSessionId, chatThreadId, runId],
      );
      assert.deepEqual(instance.rows, [
        { pricingUnitPrice: "0", pricingUnitSize: "1" },
      ]);
      console.log(
        "   ✅ current API browser create/start writes work before migration 0734\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateThreadBrowserIdentityAfterMigration(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.4: Validate thread browser rollout compatibility ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const legacyBrowserProfileId = "00000000-0000-4000-8000-000000073501";
  const legacyProviderProfileId = "00000000-0000-4000-8000-000000073502";
  const legacyBrowserSessionId = "00000000-0000-4000-8000-000000073503";
  const legacyProviderSessionId = "00000000-0000-4000-8000-000000073504";
  const legacyChatThreadId = "00000000-0000-4000-8000-000000073505";
  const legacyRunId = "00000000-0000-4000-8000-000000073506";
  const threadProviderProfileId = "00000000-0000-4000-8000-000000077201";
  const threadChatThreadId = "00000000-0000-4000-8000-000000077202";
  const threadProviderSessionId = "00000000-0000-4000-8000-000000077203";
  const threadRunId = "00000000-0000-4000-8000-000000077204";

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
    assert.deepEqual(tables.rows, [
      {
        browserProfiles: "browser_profiles",
        tabSnapshots: "browser_session_tab_snapshots",
      },
    ]);

    const columns = await client.query<{
      columnName: string;
      isNullable: string;
      tableName: string;
    }>(
      `
        SELECT
          "table_name" AS "tableName",
          "column_name" AS "columnName",
          "is_nullable" AS "isNullable"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND ("table_name", "column_name") IN (
            ('browser_sessions', 'browser_profile_id'),
            ('browser_session_instances', 'browser_session_id')
          )
        ORDER BY "table_name", "column_name"
      `,
    );
    assert.deepEqual(columns.rows, [
      {
        tableName: "browser_session_instances",
        columnName: "browser_session_id",
        isNullable: "YES",
      },
      {
        tableName: "browser_sessions",
        columnName: "browser_profile_id",
        isNullable: "YES",
      },
    ]);

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
    assert.deepEqual(primaryKeys.rows, [
      { tableName: "browser_sessions", columnName: "id" },
      { tableName: "browser_thread_profiles", columnName: "id" },
    ]);

    const pricing = await client.query<{
      unitPrice: string;
      unitSize: string;
    }>(
      `
        SELECT
          "unit_price"::text AS "unitPrice",
          "unit_size"::text AS "unitSize"
        FROM "usage_pricing"
        WHERE "kind" = 'browser'
          AND "provider" = 'browser-use'
          AND "category" = 'provider_cost_usd_micros'
        LIMIT 1
      `,
    );
    assert.deepEqual(pricing.rows, [{ unitPrice: "0", unitSize: "1" }]);
    const pricingRow = pricing.rows[0];
    if (!pricingRow) {
      throw new Error("Previous browser API pricing lookup returned no row");
    }

    // Previous-API statement shapes must remain legal after the migration.
    await client.query(
      `
        INSERT INTO "browser_profiles" (
          "id",
          "org_id",
          "user_id",
          "provider_profile_id"
        )
        VALUES ($1, 'browser-drain-org', 'browser-drain-user', $2)
      `,
      [legacyBrowserProfileId, legacyProviderProfileId],
    );
    await client.query(
      `
        INSERT INTO "browser_sessions" (
          "id",
          "chat_thread_id",
          "run_id",
          "org_id",
          "user_id",
          "name",
          "browser_profile_id",
          "status",
          "proxy_country_code",
          "timeout_minutes",
          "max_credits"
        )
        VALUES (
          $1,
          $2,
          NULL,
          'browser-drain-org',
          'browser-drain-user',
          'previous-api-start',
          $3,
          'creating',
          NULL,
          240,
          500
        )
      `,
      [legacyBrowserSessionId, legacyChatThreadId, legacyBrowserProfileId],
    );
    const legacyInstance = await client.query<{
      pricingUnitPrice: string;
      pricingUnitSize: string;
    }>(
      `
        INSERT INTO "browser_session_instances" (
          "provider_session_id",
          "browser_session_id",
          "chat_thread_id",
          "run_id",
          "status",
          "pricing_unit_price",
          "pricing_unit_size",
          "timeout_at",
          "started_at",
          "last_touched_at",
          "idle_expires_at"
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'active',
          $5::bigint,
          $6::bigint,
          now() + interval '240 minutes',
          now(),
          now(),
          now() + interval '10 minutes'
        )
        RETURNING
          "pricing_unit_price"::text AS "pricingUnitPrice",
          "pricing_unit_size"::text AS "pricingUnitSize"
      `,
      [
        legacyProviderSessionId,
        legacyBrowserSessionId,
        legacyChatThreadId,
        legacyRunId,
        pricingRow.unitPrice,
        pricingRow.unitSize,
      ],
    );
    assert.deepEqual(legacyInstance.rows, [
      { pricingUnitPrice: "0", pricingUnitSize: "1" },
    ]);

    // Current-API inserts intentionally omit every legacy identity and billing
    // field while the physical compatibility columns remain.
    await client.query(
      `
        INSERT INTO "browser_thread_profiles" (
          "chat_thread_id",
          "org_id",
          "user_id",
          "provider_profile_id"
        )
        VALUES ($1, 'thread-browser-org', 'thread-browser-user', $2)
      `,
      [threadChatThreadId, threadProviderProfileId],
    );
    await client.query(
      `
        INSERT INTO "browser_sessions" (
          "chat_thread_id",
          "run_id",
          "org_id",
          "user_id",
          "name",
          "status",
          "proxy_country_code",
          "timeout_minutes"
        )
        VALUES (
          $1,
          NULL,
          'thread-browser-org',
          'thread-browser-user',
          'thread-browser-start',
          'creating',
          NULL,
          240
        )
      `,
      [threadChatThreadId],
    );
    await client.query(
      `
        INSERT INTO "browser_session_instances" (
          "provider_session_id",
          "chat_thread_id",
          "run_id",
          "status",
          "timeout_at",
          "started_at",
          "last_touched_at",
          "idle_expires_at"
        )
        VALUES (
          $1,
          $2,
          $3,
          'active',
          now() + interval '240 minutes',
          now(),
          now(),
          now() + interval '10 minutes'
        )
      `,
      [threadProviderSessionId, threadChatThreadId, threadRunId],
    );

    const lifecycleConstraint = await client.query<{ definition: string }>(
      `
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `,
    );
    assert.equal(lifecycleConstraint.rows.length, 1);
    assert.match(
      lifecycleConstraint.rows[0]?.definition ?? "",
      /browser\.started/u,
    );
    assert.match(
      lifecycleConstraint.rows[0]?.definition ?? "",
      /browser\.stopped/u,
    );
    console.log("   ✅ previous browser API statements remain valid");
    console.log("   ✅ current thread-keyed browser inserts omit legacy IDs");
    console.log(
      "   ✅ browser lifecycle events and tab snapshots are available\n",
    );
  } finally {
    await client.query(
      `DELETE FROM "browser_session_instances" WHERE "provider_session_id" IN ($1, $2)`,
      [legacyProviderSessionId, threadProviderSessionId],
    );
    await client.query(
      `DELETE FROM "browser_sessions" WHERE "chat_thread_id" IN ($1, $2)`,
      [legacyChatThreadId, threadChatThreadId],
    );
    await client.query(
      `DELETE FROM "browser_thread_profiles" WHERE "chat_thread_id" = $1`,
      [threadChatThreadId],
    );
    await client.query(`DELETE FROM "browser_profiles" WHERE "id" = $1`, [
      legacyBrowserProfileId,
    ]);
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
    id: string;
    seqId: string;
    userMessage: unknown;
  }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "content",
        "event_type",
        "seq_id",
        "user_message"
      )
      VALUES (
        $1,
        NULL,
        'input.prompt',
        $2,
        $3::jsonb
      )
      RETURNING
        "id",
        "seq_id" AS "seqId",
        "content",
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
          "seq_id"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000074510',
            $1,
            'output.message',
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
            2
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
    ]);

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_pair_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074512',
          $1,
          'output.message',
          'slack',
          3
        )
      `,
      values: [threadId],
    });
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
          'telegram',
          '00000000-0000-4000-8000-000000074505',
          3
        )
      `,
      values: [threadId],
    });

    console.log(
      "   ✅ Chat event context pointers are paired and reject unknown types\n",
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

  let prevId = "";
  let chainBroken = false;
  for (const entry of entries) {
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));

    if (snapshot.prevId !== prevId) {
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

async function applyMigrationsUpTo(
  client: Client,
  upToIdx: number,
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

  // Apply migrations up to the specified index
  for (const entry of entries) {
    if (entry.idx > upToIdx) break;

    const sqlFile = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const sql = await fs.readFile(sqlFile, "utf-8");

    // Check if already applied
    const result = await client.query(
      `SELECT 1 FROM "__drizzle_migrations" WHERE hash = $1`,
      [entry.tag],
    );

    if (result.rows.length === 0) {
      // Apply migration
      await client.query(sql);
      // Record in migrations table
      await client.query(
        `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [entry.tag, Date.now()],
      );
    }
  }
}

async function runMigrationsUpTo(
  dbUrl: string,
  upToIdx: number,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await applyMigrationsUpTo(client, upToIdx);
  } finally {
    await client.end();
  }
}

async function waitForMigrationBlockedBy(
  client: Client,
  args: {
    readonly blockerPid: number;
    readonly migrationPid: number;
  },
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await client.query<{ blocked: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity AS activity
          WHERE activity.datname = current_database()
            AND activity.pid = $1
            AND $2::integer = ANY(pg_blocking_pids(activity.pid))
        ) AS blocked
      `,
      [args.migrationPid, args.blockerPid],
    );
    if (result.rows[0]?.blocked === true) {
      return;
    }
    await delay(10);
  }

  throw new Error(
    `Migration did not block on backend ${args.blockerPid} before the synchronization deadline`,
  );
}

async function runConnectorBackfillWithConcurrentDeletes(args: {
  readonly dbUrl: string;
  readonly secretConnectorId: string;
  readonly variableConnectorId: string;
}): Promise<void> {
  const migrationClient = new Client({ connectionString: args.dbUrl });
  const secretDeleteClient = new Client({ connectionString: args.dbUrl });
  const variableDeleteClient = new Client({ connectionString: args.dbUrl });
  await migrationClient.connect();
  await secretDeleteClient.connect();
  await variableDeleteClient.connect();

  let secretDeleteOpen = false;
  let variableDeleteOpen = false;
  let migrationOutcomePromise:
    | Promise<
        | { readonly kind: "success" }
        | { readonly kind: "failure"; readonly error: unknown }
      >
    | undefined;
  try {
    const secretDeletePidResult = await secretDeleteClient.query<{
      pid: number;
    }>(`SELECT pg_backend_pid() AS pid`);
    const variableDeletePidResult = await variableDeleteClient.query<{
      pid: number;
    }>(`SELECT pg_backend_pid() AS pid`);
    const migrationPidResult = await migrationClient.query<{
      pid: number;
    }>(`SELECT pg_backend_pid() AS pid`);
    const secretDeletePid = secretDeletePidResult.rows[0]?.pid;
    const variableDeletePid = variableDeletePidResult.rows[0]?.pid;
    const migrationPid = migrationPidResult.rows[0]?.pid;
    if (
      secretDeletePid === undefined ||
      variableDeletePid === undefined ||
      migrationPid === undefined
    ) {
      throw new Error("Failed to read concurrent delete backend identifiers");
    }

    await secretDeleteClient.query("BEGIN");
    secretDeleteOpen = true;
    const secretDelete = await secretDeleteClient.query(
      `DELETE FROM "connectors" WHERE "id" = $1`,
      [args.secretConnectorId],
    );
    assert.equal(secretDelete.rowCount, 1);

    await variableDeleteClient.query("BEGIN");
    variableDeleteOpen = true;
    const variableDelete = await variableDeleteClient.query(
      `DELETE FROM "connectors" WHERE "id" = $1`,
      [args.variableConnectorId],
    );
    assert.equal(variableDelete.rowCount, 1);

    migrationOutcomePromise = applyMigrationsUpTo(migrationClient, 628).then(
      () => {
        return { kind: "success" } as const;
      },
      (error: unknown) => {
        return { kind: "failure", error } as const;
      },
    );

    await waitForMigrationBlockedBy(secretDeleteClient, {
      blockerPid: secretDeletePid,
      migrationPid,
    });
    await secretDeleteClient.query("COMMIT");
    secretDeleteOpen = false;

    await waitForMigrationBlockedBy(secretDeleteClient, {
      blockerPid: variableDeletePid,
      migrationPid,
    });
    await variableDeleteClient.query("COMMIT");
    variableDeleteOpen = false;

    const migrationOutcome = await migrationOutcomePromise;
    if (migrationOutcome.kind === "failure") {
      throw migrationOutcome.error;
    }
  } finally {
    if (secretDeleteOpen) {
      await secretDeleteClient.query("ROLLBACK");
    }
    if (variableDeleteOpen) {
      await variableDeleteClient.query("ROLLBACK");
    }
    if (migrationOutcomePromise !== undefined) {
      await migrationOutcomePromise;
    }
    await migrationClient.end();
    await secretDeleteClient.end();
    await variableDeleteClient.end();
  }
}

async function validateConnectorCredentialOwnershipBackfill(): Promise<void> {
  console.log(
    "=== Phase 1.25: Validate connector credential ownership backfill ===\n",
  );
  const testDb = "migration_connector_credential_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const connectorIds = {
    github: "00000000-0000-4000-8000-000000000001",
    gumroad: "00000000-0000-4000-8000-000000000002",
    unknown: "00000000-0000-4000-8000-000000000003",
    steam: "00000000-0000-4000-8000-000000000004",
    unknownMethod: "00000000-0000-4000-8000-000000000005",
    concurrentSecretDelete: "00000000-0000-4000-8000-000000000006",
    concurrentVariableDelete: "00000000-0000-4000-8000-000000000007",
  } as const;
  const secretIds = {
    github: "10000000-0000-4000-8000-000000000001",
    staleMethod: "10000000-0000-4000-8000-000000000002",
    unknown: "10000000-0000-4000-8000-000000000003",
    user: "10000000-0000-4000-8000-000000000004",
    preowned: "10000000-0000-4000-8000-000000000005",
    unknownMethod: "10000000-0000-4000-8000-000000000006",
    concurrentDelete: "10000000-0000-4000-8000-000000000007",
  } as const;
  const variableIds = {
    steam: "20000000-0000-4000-8000-000000000001",
    unknown: "20000000-0000-4000-8000-000000000002",
    user: "20000000-0000-4000-8000-000000000003",
    concurrentDelete: "20000000-0000-4000-8000-000000000004",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 627);
    const seedClient = new Client({ connectionString: testDbUrl });
    await seedClient.connect();
    try {
      await seedClient.query(
        `
          INSERT INTO "connectors"
            ("id", "type", "auth_method", "storage_version", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'github', 'oauth', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($2, 'gumroad', 'oauth', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($3, 'unknown-ref', 'api-token', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($4, 'steam', 'openid', 7, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($5, 'github', 'missing-method', NULL, 'backfill-org', 'other-user', '2020-01-01'),
            ($6, 'github', 'missing-method', NULL, 'backfill-org', 'concurrent-secret-delete-user', '2020-01-01'),
            ($7, 'steam', 'missing-method', NULL, 'backfill-org', 'concurrent-variable-delete-user', '2020-01-01')
        `,
        Object.values(connectorIds),
      );
      await seedClient.query(
        `
          INSERT INTO "secrets"
            ("id", "name", "encrypted_value", "type", "connector_id", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'GITHUB_ACCESS_TOKEN', 'github-value', 'connector', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($2, 'GUMROAD_TOKEN', 'stale-method-value', 'connector', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($3, 'UNKNOWN_CONNECTOR_SECRET', 'unknown-value', 'connector', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($4, 'GITHUB_ACCESS_TOKEN', 'user-value', 'user', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($5, 'PREOWNED_CONNECTOR_SECRET', 'preowned-value', 'connector', $8, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($6, 'GITHUB_ACCESS_TOKEN', 'unknown-method-value', 'connector', NULL, 'backfill-org', 'other-user', '2020-01-01'),
            ($7, 'GITHUB_ACCESS_TOKEN', 'concurrent-delete-value', 'connector', NULL, 'backfill-org', 'concurrent-secret-delete-user', '2020-01-01')
        `,
        [...Object.values(secretIds), connectorIds.gumroad],
      );
      await seedClient.query(
        `
          INSERT INTO "variables"
            ("id", "name", "value", "type", "connector_id", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'STEAM_ID', 'steam-value', 'connector', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($2, 'UNKNOWN_CONNECTOR_VARIABLE', 'unknown-variable-value', 'connector', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($3, 'STEAM_ID', 'user-variable-value', 'user', NULL, 'backfill-org', 'backfill-user', '2020-01-01'),
            ($4, 'STEAM_ID', 'concurrent-delete-variable-value', 'connector', NULL, 'backfill-org', 'concurrent-variable-delete-user', '2020-01-01')
        `,
        Object.values(variableIds),
      );
    } finally {
      await seedClient.end();
    }

    await runConnectorBackfillWithConcurrentDeletes({
      dbUrl: testDbUrl,
      secretConnectorId: connectorIds.concurrentSecretDelete,
      variableConnectorId: connectorIds.concurrentVariableDelete,
    });
    const assertionClient = new Client({ connectionString: testDbUrl });
    await assertionClient.connect();
    try {
      const connectorRows = await assertionClient.query<{
        id: string;
        storage_version: string | null;
        updated_at: string;
      }>(
        `SELECT "id", "storage_version", "updated_at"::text AS "updated_at" FROM "connectors" ORDER BY "id"`,
      );
      const connectorVersions = new Map(
        connectorRows.rows.map((row) => {
          return [row.id, row.storage_version] as const;
        }),
      );
      assert.equal(connectorVersions.get(connectorIds.github), "1");
      assert.equal(connectorVersions.get(connectorIds.gumroad), "1");
      assert.equal(connectorVersions.get(connectorIds.unknown), null);
      assert.equal(connectorVersions.get(connectorIds.steam), "7");
      assert.equal(connectorVersions.get(connectorIds.unknownMethod), null);
      assert.equal(
        connectorVersions.get(connectorIds.concurrentSecretDelete),
        undefined,
      );
      assert.equal(
        connectorVersions.get(connectorIds.concurrentVariableDelete),
        undefined,
      );
      for (const row of connectorRows.rows) {
        assert.equal(row.updated_at, "2020-01-01 00:00:00");
      }

      const secretRows = await assertionClient.query<{
        connector_id: string | null;
        encrypted_value: string;
        id: string;
        updated_at: string;
      }>(
        `SELECT "id", "connector_id", "encrypted_value", "updated_at"::text AS "updated_at" FROM "secrets" WHERE "id"::text LIKE '10000000-%' ORDER BY "id"`,
      );
      const secretOwners = new Map(
        secretRows.rows.map((row) => {
          return [row.id, row.connector_id] as const;
        }),
      );
      assert.equal(secretOwners.get(secretIds.github), connectorIds.github);
      assert.equal(
        secretOwners.get(secretIds.staleMethod),
        connectorIds.gumroad,
      );
      assert.equal(secretOwners.get(secretIds.unknown), null);
      assert.equal(secretOwners.get(secretIds.user), null);
      assert.equal(secretOwners.get(secretIds.preowned), connectorIds.gumroad);
      assert.equal(
        secretOwners.get(secretIds.unknownMethod),
        connectorIds.unknownMethod,
      );
      assert.equal(secretOwners.get(secretIds.concurrentDelete), null);
      assert.deepEqual(
        secretRows.rows.map((row) => {
          return row.encrypted_value;
        }),
        [
          "github-value",
          "stale-method-value",
          "unknown-value",
          "user-value",
          "preowned-value",
          "unknown-method-value",
          "concurrent-delete-value",
        ],
      );
      for (const row of secretRows.rows) {
        assert.equal(row.updated_at, "2020-01-01 00:00:00");
      }

      const variableRows = await assertionClient.query<{
        connector_id: string | null;
        id: string;
        updated_at: string;
        value: string;
      }>(
        `SELECT "id", "connector_id", "value", "updated_at"::text AS "updated_at" FROM "variables" WHERE "id"::text LIKE '20000000-%' ORDER BY "id"`,
      );
      const variableOwners = new Map(
        variableRows.rows.map((row) => {
          return [row.id, row.connector_id] as const;
        }),
      );
      assert.equal(variableOwners.get(variableIds.steam), connectorIds.steam);
      assert.equal(variableOwners.get(variableIds.unknown), null);
      assert.equal(variableOwners.get(variableIds.user), null);
      assert.equal(variableOwners.get(variableIds.concurrentDelete), null);
      assert.deepEqual(
        variableRows.rows.map((row) => {
          return row.value;
        }),
        [
          "steam-value",
          "unknown-variable-value",
          "user-variable-value",
          "concurrent-delete-variable-value",
        ],
      );
      for (const row of variableRows.rows) {
        assert.equal(row.updated_at, "2020-01-01 00:00:00");
      }
    } finally {
      await assertionClient.end();
    }
    console.log(
      "   ✅ Backfill updates only recognized connector versions and owners and serializes concurrent deletes\n",
    );
  } finally {
    await dropDatabase(testDb);
  }
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

async function validateConnectorCatalogCompatibilityFormatRollout(): Promise<void> {
  console.log(
    "=== Validate connector catalog compatibility format rollout ===\n",
  );
  const testDb = "migration_connector_catalog_format_rollout_test";
  const testDbUrl = createTestDbUrl(testDb);
  const sourceId = "migration-catalog-format";
  const catalogDigest = `sha256:${"a".repeat(64)}`;
  const legacyCapabilityDigest = `sha256:${"b".repeat(64)}`;
  const previousWriterCapabilityDigest = `sha256:${"c".repeat(64)}`;
  const invalidCapabilityDigest = `sha256:${"d".repeat(64)}`;
  const firstBuildCommitSha = "1".repeat(40);
  const secondBuildCommitSha = "2".repeat(40);
  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0778_windy_firelord.sql"),
    "utf8",
  );
  assert.match(
    migrationSql,
    /ADD COLUMN "compatibility_format_version" integer DEFAULT 1 NOT NULL/u,
  );
  assert.doesNotMatch(migrationSql, /\b(?:CREATE TABLE|DROP)\b/u);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 777);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "connector_catalog_sync_state" (
            "source_id",
            "schema_version"
          )
          VALUES ($1, 1)
        `,
        [sourceId],
      );
      await client.query(
        `
          INSERT INTO "connector_catalog_compatibility_evaluation" (
            "source_id",
            "schema_version",
            "catalog_version",
            "catalog_digest",
            "executable_capability_digest",
            "catalog_validation_backend_version",
            "catalog_validation_build_commit_sha",
            "evaluated_at",
            "filtered_auth_methods"
          )
          VALUES (
            $1,
            1,
            '2026-07-31.1',
            $2,
            $3,
            '1.0.0',
            $4,
            '2026-07-31 00:00:00',
            '[]'::jsonb
          )
        `,
        [sourceId, catalogDigest, legacyCapabilityDigest, firstBuildCommitSha],
      );

      await applyMigrationsUpTo(client, 778);

      const migratedRows = await client.query<{
        compatibilityFormatVersion: number;
        filteredAuthMethods: unknown;
      }>(
        `
          SELECT
            "compatibility_format_version" AS "compatibilityFormatVersion",
            "filtered_auth_methods" AS "filteredAuthMethods"
          FROM "connector_catalog_compatibility_evaluation"
          WHERE "source_id" = $1
            AND "executable_capability_digest" = $2
        `,
        [sourceId, legacyCapabilityDigest],
      );
      assert.deepEqual(migratedRows.rows, [
        {
          compatibilityFormatVersion: 1,
          filteredAuthMethods: [],
        },
      ]);

      const previousWriterSql = `
        INSERT INTO "connector_catalog_compatibility_evaluation" (
          "source_id",
          "schema_version",
          "catalog_version",
          "catalog_digest",
          "executable_capability_digest",
          "catalog_validation_backend_version",
          "catalog_validation_build_commit_sha",
          "evaluated_at",
          "filtered_auth_methods"
        )
        VALUES (
          $1,
          1,
          '2026-07-31.1',
          $2,
          $3,
          $4,
          $5,
          $6,
          '[]'::jsonb
        )
        ON CONFLICT (
          "source_id",
          "schema_version",
          "catalog_version",
          "catalog_digest",
          "executable_capability_digest"
        )
        DO UPDATE SET
          "catalog_validation_backend_version" = $4,
          "catalog_validation_build_commit_sha" = $5,
          "evaluated_at" = $6,
          "filtered_auth_methods" = '[]'::jsonb
        WHERE (
          "connector_catalog_compatibility_evaluation".
            "catalog_validation_backend_version" IS NULL
          OR string_to_array(
            "connector_catalog_compatibility_evaluation".
              "catalog_validation_backend_version",
            '.'
          )::numeric[] <= string_to_array($4, '.')::numeric[]
        )
      `;
      const inserted = await client.query(previousWriterSql, [
        sourceId,
        catalogDigest,
        previousWriterCapabilityDigest,
        "1.0.0",
        firstBuildCommitSha,
        "2026-07-31 01:00:00",
      ]);
      assert.equal(inserted.rowCount, 1);
      const updated = await client.query(previousWriterSql, [
        sourceId,
        catalogDigest,
        previousWriterCapabilityDigest,
        "1.1.0",
        secondBuildCommitSha,
        "2026-07-31 02:00:00",
      ]);
      assert.equal(updated.rowCount, 1);
      const downgrade = await client.query(previousWriterSql, [
        sourceId,
        catalogDigest,
        previousWriterCapabilityDigest,
        "1.0.0",
        firstBuildCommitSha,
        "2026-07-31 03:00:00",
      ]);
      assert.equal(downgrade.rowCount, 0);

      const previousWriterRows = await client.query<{
        backendVersion: string | null;
        buildCommitSha: string | null;
        compatibilityFormatVersion: number;
        evaluatedAt: string;
      }>(
        `
          SELECT
            "compatibility_format_version" AS "compatibilityFormatVersion",
            "catalog_validation_backend_version" AS "backendVersion",
            "catalog_validation_build_commit_sha" AS "buildCommitSha",
            "evaluated_at"::text AS "evaluatedAt"
          FROM "connector_catalog_compatibility_evaluation"
          WHERE "source_id" = $1
            AND "executable_capability_digest" = $2
        `,
        [sourceId, previousWriterCapabilityDigest],
      );
      assert.deepEqual(previousWriterRows.rows, [
        {
          compatibilityFormatVersion: 1,
          backendVersion: "1.1.0",
          buildCommitSha: secondBuildCommitSha,
          evaluatedAt: "2026-07-31 02:00:00",
        },
      ]);

      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "connector_catalog_compat_format_version_positive",
        query: `
          INSERT INTO "connector_catalog_compatibility_evaluation" (
            "source_id",
            "schema_version",
            "catalog_version",
            "catalog_digest",
            "executable_capability_digest",
            "compatibility_format_version",
            "evaluated_at",
            "filtered_auth_methods"
          )
          VALUES (
            $1,
            1,
            '2026-07-31.1',
            $2,
            $3,
            0,
            '2026-07-31 04:00:00',
            '[]'::jsonb
          )
        `,
        values: [sourceId, catalogDigest, invalidCapabilityDigest],
      });

      console.log(
        "   ✅ Existing rows and previous-writer upserts remain format 1, while invalid versions are rejected\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
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
      "auth_mode",
      "created_by"
    )
    VALUES ($1, $2, $3, $4, '[]'::jsonb, 'Authorization', 'Bearer {{secret}}', $5, $6)
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

async function validateConnectorCredentialOwnershipContraction(): Promise<void> {
  console.log(
    "=== Phase 1.5: Validate connector credential ownership contraction ===\n",
  );
  const successDb = "migration_connector_credential_contraction_success_test";
  const failureDb = "migration_connector_credential_contraction_failure_test";
  const successDbUrl = createTestDbUrl(successDb);
  const failureDbUrl = createTestDbUrl(failureDb);
  const successConnectorIds = {
    github: "30000000-0000-4000-8000-000000000001",
    steam: "30000000-0000-4000-8000-000000000002",
  } as const;
  const successCredentialIds = {
    connectorSecret: "40000000-0000-4000-8000-000000000001",
    connectorVariable: "40000000-0000-4000-8000-000000000002",
    userSecret: "40000000-0000-4000-8000-000000000003",
    userVariable: "40000000-0000-4000-8000-000000000004",
  } as const;

  await createDatabase(successDb);
  try {
    await runMigrationsUpTo(successDbUrl, 628);
    const client = new Client({ connectionString: successDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "connectors"
            ("id", "type", "auth_method", "storage_version", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'github', 'oauth', NULL, 'contract-org', 'contract-user', '2020-01-01'),
            ($2, 'steam', 'openid', NULL, 'contract-org', 'contract-user', '2020-01-01')
        `,
        Object.values(successConnectorIds),
      );
      await client.query(
        `
          INSERT INTO "secrets"
            ("id", "name", "encrypted_value", "description", "type", "connector_id", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'GITHUB_ACCESS_TOKEN', 'contract-secret-value', 'contract-secret-description', 'connector', NULL, 'contract-org', 'contract-user', '2020-01-01'),
            ($2, 'CONTRACT_USER_SECRET', 'user-secret-value', 'user-secret-description', 'user', NULL, 'contract-org', 'contract-user', '2020-01-01')
        `,
        [successCredentialIds.connectorSecret, successCredentialIds.userSecret],
      );
      await client.query(
        `
          INSERT INTO "variables"
            ("id", "name", "value", "description", "type", "connector_id", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'STEAM_ID', 'contract-variable-value', 'contract-variable-description', 'connector', NULL, 'contract-org', 'contract-user', '2020-01-01'),
            ($2, 'CONTRACT_USER_VARIABLE', 'user-variable-value', 'user-variable-description', 'user', NULL, 'contract-org', 'contract-user', '2020-01-01')
        `,
        [
          successCredentialIds.connectorVariable,
          successCredentialIds.userVariable,
        ],
      );

      await client.query("BEGIN");
      await applyMigrationsUpTo(client, 630);
      await client.query("COMMIT");

      const connectorRows = await client.query<{
        id: string;
        storage_version: string;
        updated_at: string;
      }>(
        `
          SELECT "id", "storage_version", "updated_at"::text AS "updated_at"
          FROM "connectors"
          WHERE "id" = ANY($1::uuid[])
          ORDER BY "id"
        `,
        [Object.values(successConnectorIds)],
      );
      assert.deepEqual(connectorRows.rows, [
        {
          id: successConnectorIds.github,
          storage_version: "1",
          updated_at: "2020-01-01 00:00:00",
        },
        {
          id: successConnectorIds.steam,
          storage_version: "1",
          updated_at: "2020-01-01 00:00:00",
        },
      ]);

      const secretRow = await client.query<{
        connector_id: string;
        description: string;
        encrypted_value: string;
        updated_at: string;
      }>(
        `
          SELECT "connector_id", "description", "encrypted_value", "updated_at"::text AS "updated_at"
          FROM "secrets"
          WHERE "id" = $1
        `,
        [successCredentialIds.connectorSecret],
      );
      assert.deepEqual(secretRow.rows[0], {
        connector_id: successConnectorIds.github,
        description: "contract-secret-description",
        encrypted_value: "contract-secret-value",
        updated_at: "2020-01-01 00:00:00",
      });

      const variableRow = await client.query<{
        connector_id: string;
        description: string;
        updated_at: string;
        value: string;
      }>(
        `
          SELECT "connector_id", "description", "value", "updated_at"::text AS "updated_at"
          FROM "variables"
          WHERE "id" = $1
        `,
        [successCredentialIds.connectorVariable],
      );
      assert.deepEqual(variableRow.rows[0], {
        connector_id: successConnectorIds.steam,
        description: "contract-variable-description",
        updated_at: "2020-01-01 00:00:00",
        value: "contract-variable-value",
      });

      await expectDatabaseError(client, {
        code: "23502",
        query: `
          INSERT INTO "connectors"
            ("type", "auth_method", "storage_version", "org_id", "user_id")
          VALUES ('github', 'oauth', NULL, 'invalid-org', 'invalid-null-version')
        `,
      });
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chk_connectors_storage_version_positive",
        query: `
          INSERT INTO "connectors"
            ("type", "auth_method", "storage_version", "org_id", "user_id")
          VALUES ('github', 'oauth', 0, 'invalid-org', 'invalid-zero-version')
        `,
      });
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chk_secrets_connector_owner_type",
        query: `
          INSERT INTO "secrets"
            ("name", "encrypted_value", "type", "org_id", "user_id")
          VALUES ('UNOWNED_CONNECTOR_SECRET', 'value', 'connector', 'invalid-org', 'invalid-user')
        `,
      });
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chk_variables_connector_owner_type",
        query: `
          INSERT INTO "variables"
            ("name", "value", "type", "org_id", "user_id")
          VALUES ('UNOWNED_CONNECTOR_VARIABLE', 'value', 'connector', 'invalid-org', 'invalid-user')
        `,
      });
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chk_secrets_connector_owner_type",
        query: `
          INSERT INTO "secrets"
            ("name", "encrypted_value", "type", "connector_id", "org_id", "user_id")
          VALUES ('OWNED_USER_SECRET', 'value', 'user', $1, 'contract-org', 'contract-user')
        `,
        values: [successConnectorIds.github],
      });
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chk_variables_connector_owner_type",
        query: `
          INSERT INTO "variables"
            ("name", "value", "type", "connector_id", "org_id", "user_id")
          VALUES ('OWNED_USER_VARIABLE', 'value', 'user', $1, 'contract-org', 'contract-user')
        `,
        values: [successConnectorIds.github],
      });
      const deletedConnectors = await client.query(
        `DELETE FROM "connectors" WHERE "id" = ANY($1::uuid[])`,
        [Object.values(successConnectorIds)],
      );
      assert.equal(deletedConnectors.rowCount, 2);

      const userRows = await client.query<{
        connector_secret_count: string;
        connector_variable_count: string;
        secret_count: string;
        variable_count: string;
      }>(
        `
          SELECT
            (SELECT count(*) FROM "secrets" WHERE "id" = $1)::text AS connector_secret_count,
            (SELECT count(*) FROM "variables" WHERE "id" = $2)::text AS connector_variable_count,
            (SELECT count(*) FROM "secrets" WHERE "id" = $3)::text AS secret_count,
            (SELECT count(*) FROM "variables" WHERE "id" = $4)::text AS variable_count
        `,
        [
          successCredentialIds.connectorSecret,
          successCredentialIds.connectorVariable,
          successCredentialIds.userSecret,
          successCredentialIds.userVariable,
        ],
      );
      assert.deepEqual(userRows.rows[0], {
        connector_secret_count: "0",
        connector_variable_count: "0",
        secret_count: "1",
        variable_count: "1",
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(successDb);
  }

  await createDatabase(failureDb);
  try {
    await runMigrationsUpTo(failureDbUrl, 628);
    const client = new Client({ connectionString: failureDbUrl });
    await client.connect();
    const knownConnectorId = "50000000-0000-4000-8000-000000000001";
    const unknownConnectorId = "50000000-0000-4000-8000-000000000002";
    const knownSecretId = "60000000-0000-4000-8000-000000000001";
    const unknownSecretId = "60000000-0000-4000-8000-000000000002";
    const unknownVariableId = "60000000-0000-4000-8000-000000000003";
    try {
      await client.query(
        `
          INSERT INTO "connectors"
            ("id", "type", "auth_method", "storage_version", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'github', 'oauth', NULL, 'failure-org', 'failure-user', '2020-01-01'),
            ($2, 'unknown-ref', 'api-token', NULL, 'failure-org', 'failure-user', '2020-01-01')
        `,
        [knownConnectorId, unknownConnectorId],
      );
      await client.query(
        `
          INSERT INTO "secrets"
            ("id", "name", "encrypted_value", "type", "connector_id", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'GITHUB_ACCESS_TOKEN', 'known-secret-value', 'connector', NULL, 'failure-org', 'failure-user', '2020-01-01'),
            ($2, 'UNKNOWN_CONTRACT_SECRET', 'unknown-secret-value', 'connector', NULL, 'failure-org', 'failure-user', '2020-01-01')
        `,
        [knownSecretId, unknownSecretId],
      );
      await client.query(
        `
          INSERT INTO "variables"
            ("id", "name", "value", "type", "connector_id", "org_id", "user_id", "updated_at")
          VALUES
            ($1, 'UNKNOWN_CONTRACT_VARIABLE', 'unknown-variable-value', 'connector', NULL, 'failure-org', 'failure-user', '2020-01-01')
        `,
        [unknownVariableId],
      );

      const migrationSql = await fs.readFile(
        path.join(
          MIGRATIONS_DIR,
          "0630_contract_connector_credential_ownership.sql",
        ),
        "utf-8",
      );
      await client.query("BEGIN");
      try {
        await client.query(migrationSql);
        throw new Error("Expected connector credential contraction to fail");
      } catch (error) {
        assert.equal(databaseErrorCode(error), "23514");
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("missing_connector_versions=1"));
        assert.ok(error.message.includes("unowned_connector_secrets=1"));
        assert.ok(error.message.includes("unowned_connector_variables=1"));
        assert.ok(!error.message.includes("UNKNOWN_CONTRACT_SECRET"));
        assert.ok(!error.message.includes("unknown-secret-value"));
        assert.ok(!error.message.includes("failure-user"));
      }
      await client.query("ROLLBACK");

      const rolledBackConnector = await client.query<{
        storage_version: string | null;
        updated_at: string;
      }>(
        `
          SELECT "storage_version", "updated_at"::text AS "updated_at"
          FROM "connectors"
          WHERE "id" = $1
        `,
        [knownConnectorId],
      );
      assert.deepEqual(rolledBackConnector.rows[0], {
        storage_version: null,
        updated_at: "2020-01-01 00:00:00",
      });
      const rolledBackSecret = await client.query<{
        connector_id: string | null;
        encrypted_value: string;
        updated_at: string;
      }>(
        `
          SELECT "connector_id", "encrypted_value", "updated_at"::text AS "updated_at"
          FROM "secrets"
          WHERE "id" = $1
        `,
        [knownSecretId],
      );
      assert.deepEqual(rolledBackSecret.rows[0], {
        connector_id: null,
        encrypted_value: "known-secret-value",
        updated_at: "2020-01-01 00:00:00",
      });

      const schemaState = await client.query<{
        delete_rule: string;
        is_nullable: string;
      }>(`
        SELECT
          (
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'connectors'
              AND column_name = 'storage_version'
          ) AS is_nullable,
          (
            SELECT delete_rule
            FROM information_schema.referential_constraints
            WHERE constraint_schema = 'public'
              AND constraint_name = 'secrets_connector_id_connectors_id_fk'
          ) AS delete_rule
      `);
      assert.deepEqual(schemaState.rows[0], {
        delete_rule: "CASCADE",
        is_nullable: "YES",
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(failureDb);
  }

  console.log(
    "   ✅ Contraction reconciles known rows, enforces final constraints, and rolls back unresolved state\n",
  );
}

const STORAGE_ARCHIVE_SIZE_PREVIOUS_MIGRATION = 630;
const STORAGE_ARCHIVE_SIZE_FINALIZATION_MIGRATION = 631;

const storageArchiveSizeFixture = {
  orgId: "archive-finalization-org",
  storageId: "40000000-0000-4000-8000-000000000001",
  positiveVersionId: "a".repeat(64),
  emptyVersionId: "b".repeat(64),
  headVersionId: "c".repeat(64),
  historyVersionId: "d".repeat(64),
} as const;

async function applyMigrationsUpToInTransaction(
  client: Client,
  upToIdx: number,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await applyMigrationsUpTo(client, upToIdx);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const STRUCTURED_PROMPT_DRAFT_BACKFILL_PREVIOUS_MIGRATION = 707;
const STRUCTURED_PROMPT_DRAFT_BACKFILL_MIGRATION = 708;
const STRUCTURED_PROMPT_DRAFT_LEGACY_COLUMN_DROP_MIGRATION = 711;

async function validateStructuredPromptDraftBackfill(): Promise<void> {
  console.log("=== Validate structured prompt draft backfill ===\n");

  const testDb = "migration_structured_prompt_draft_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "90000000-0000-4000-8000-000000000001",
    threadIds: {
      legacy: "91000000-0000-4000-8000-000000000001",
      canonical: "91000000-0000-4000-8000-000000000002",
      equal: "91000000-0000-4000-8000-000000000003",
    },
    draftUsers: {
      legacy: "structured-prompt-backfill-legacy-user",
      canonical: "structured-prompt-backfill-canonical-user",
      equal: "structured-prompt-backfill-equal-user",
    },
    orgId: "structured-prompt-backfill-org",
  } as const;
  const canonicalDocument = {
    version: 1,
    parts: [{ type: "text", text: "canonical draft" }],
  };
  const feedbackDocument = {
    version: 1,
    parts: [
      { type: "text", text: "draft with feedback" },
      {
        type: "feedback",
        quote: "quoted draft",
        note: [{ type: "text", text: "feedback note" }],
      },
    ],
  };

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      STRUCTURED_PROMPT_DRAFT_BACKFILL_PREVIOUS_MIGRATION,
    );

    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
         VALUES ($1, $2, $3, $4)`,
        [
          fixture.composeId,
          fixture.draftUsers.legacy,
          "structured-prompt-backfill",
          fixture.orgId,
        ],
      );
      await client.query(
        `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
         VALUES ($1, $2, $3, $4)`,
        [
          fixture.composeId,
          fixture.orgId,
          fixture.draftUsers.legacy,
          "structured-prompt-backfill",
        ],
      );
      await client.query(
        `INSERT INTO "chat_threads" (
           "id",
           "user_id",
           "agent_compose_id",
           "draft_structured_prompt",
           "draft_structured_prompt_with_feedback"
         )
         VALUES
           ($1, $2, $7, $8::jsonb, $9::jsonb),
           ($3, $4, $7, $8::jsonb, NULL),
           ($5, $6, $7, $9::jsonb, $9::jsonb)`,
        [
          fixture.threadIds.legacy,
          fixture.draftUsers.legacy,
          fixture.threadIds.canonical,
          fixture.draftUsers.canonical,
          fixture.threadIds.equal,
          fixture.draftUsers.equal,
          fixture.composeId,
          JSON.stringify(canonicalDocument),
          JSON.stringify(feedbackDocument),
        ],
      );
      // Seed the compatibility columns before their backfill and removal so
      // this fixture covers the full migration sequence.
      await client.query(
        `INSERT INTO "zero_agent_drafts" (
           "user_id",
           "org_id",
           "agent_id",
           "draft_structured_prompt",
           "draft_structured_prompt_with_feedback"
         )
         VALUES
           ($1, $2, $3, $4::jsonb, $5::jsonb),
           ($6, $2, $3, $4::jsonb, NULL),
           ($7, $2, $3, $5::jsonb, $5::jsonb)`,
        [
          fixture.draftUsers.legacy,
          fixture.orgId,
          fixture.composeId,
          JSON.stringify(canonicalDocument),
          JSON.stringify(feedbackDocument),
          fixture.draftUsers.canonical,
          fixture.draftUsers.equal,
        ],
      );

      await applyMigrationsUpToInTransaction(
        client,
        STRUCTURED_PROMPT_DRAFT_BACKFILL_MIGRATION,
      );

      const chatRows = await client.query<{
        id: string;
        draft_structured_prompt: unknown;
        draft_structured_prompt_with_feedback: unknown;
      }>(
        `SELECT
           "id",
           "draft_structured_prompt",
           "draft_structured_prompt_with_feedback"
         FROM "chat_threads"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"`,
        [Object.values(fixture.threadIds)],
      );
      const chatRowsById = new Map(
        chatRows.rows.map((row) => {
          return [row.id, row] as const;
        }),
      );
      assert.deepEqual(chatRowsById.get(fixture.threadIds.legacy), {
        id: fixture.threadIds.legacy,
        draft_structured_prompt: feedbackDocument,
        draft_structured_prompt_with_feedback: feedbackDocument,
      });
      assert.deepEqual(chatRowsById.get(fixture.threadIds.canonical), {
        id: fixture.threadIds.canonical,
        draft_structured_prompt: canonicalDocument,
        draft_structured_prompt_with_feedback: null,
      });
      assert.deepEqual(chatRowsById.get(fixture.threadIds.equal), {
        id: fixture.threadIds.equal,
        draft_structured_prompt: feedbackDocument,
        draft_structured_prompt_with_feedback: feedbackDocument,
      });

      const draftRows = await client.query<{
        user_id: string;
        draft_structured_prompt: unknown;
        draft_structured_prompt_with_feedback: unknown;
      }>(
        `SELECT
           "user_id",
           "draft_structured_prompt",
           "draft_structured_prompt_with_feedback"
         FROM "zero_agent_drafts"
         WHERE "user_id" = ANY($1::text[])
         ORDER BY "user_id"`,
        [Object.values(fixture.draftUsers)],
      );
      const draftRowsByUser = new Map(
        draftRows.rows.map((row) => {
          return [row.user_id, row] as const;
        }),
      );
      assert.deepEqual(draftRowsByUser.get(fixture.draftUsers.legacy), {
        user_id: fixture.draftUsers.legacy,
        draft_structured_prompt: feedbackDocument,
        draft_structured_prompt_with_feedback: feedbackDocument,
      });
      assert.deepEqual(draftRowsByUser.get(fixture.draftUsers.canonical), {
        user_id: fixture.draftUsers.canonical,
        draft_structured_prompt: canonicalDocument,
        draft_structured_prompt_with_feedback: null,
      });
      assert.deepEqual(draftRowsByUser.get(fixture.draftUsers.equal), {
        user_id: fixture.draftUsers.equal,
        draft_structured_prompt: feedbackDocument,
        draft_structured_prompt_with_feedback: feedbackDocument,
      });

      await applyMigrationsUpToInTransaction(
        client,
        STRUCTURED_PROMPT_DRAFT_LEGACY_COLUMN_DROP_MIGRATION,
      );

      const legacyColumns = await client.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT
           "table_name",
           "column_name"
         FROM information_schema.columns
         WHERE "table_schema" = 'public'
           AND "column_name" IN (
             'structured_prompt_with_feedback',
             'draft_structured_prompt_with_feedback'
           )
         ORDER BY "table_name", "column_name"`,
      );
      assert.deepEqual(legacyColumns.rows, []);

      const canonicalRowsAfterDrop = await client.query<{
        id: string;
        draft_structured_prompt: unknown;
      }>(
        `SELECT
           "id",
           "draft_structured_prompt"
         FROM "chat_threads"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"`,
        [Object.values(fixture.threadIds)],
      );
      assert.deepEqual(
        canonicalRowsAfterDrop.rows.map((row) => {
          return [row.id, row.draft_structured_prompt] as const;
        }),
        [
          [fixture.threadIds.legacy, feedbackDocument],
          [fixture.threadIds.canonical, canonicalDocument],
          [fixture.threadIds.equal, feedbackDocument],
        ],
      );

      const canonicalDraftRowsAfterDrop = await client.query<{
        user_id: string;
        draft_structured_prompt: unknown;
      }>(
        `SELECT
           "user_id",
           "draft_structured_prompt"
         FROM "zero_agent_drafts"
         WHERE "user_id" = ANY($1::text[])
         ORDER BY "user_id"`,
        [Object.values(fixture.draftUsers)],
      );
      assert.deepEqual(
        canonicalDraftRowsAfterDrop.rows.map((row) => {
          return [row.user_id, row.draft_structured_prompt] as const;
        }),
        [
          [fixture.draftUsers.canonical, canonicalDocument],
          [fixture.draftUsers.equal, feedbackDocument],
          [fixture.draftUsers.legacy, feedbackDocument],
        ],
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Both draft tables backfill feedback, preserve canonical rows, and drop legacy columns\n",
  );
}

const USER_MESSAGE_BACKFILL_PREVIOUS_MIGRATION = 716;
const USER_MESSAGE_BACKFILL_MIGRATION = 717;
const USER_MESSAGE_CONTRACT_MIGRATION = 718;

async function validateUserMessageBackfillAndContract(): Promise<void> {
  console.log(
    "=== Validate historical userMessage backfill and contract ===\n",
  );

  const testDb = "migration_user_message_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "92000000-0000-4000-8000-000000000001";
  const threadIds = {
    events: "92000000-0000-4000-8000-000000000002",
    draft: "92000000-0000-4000-8000-000000000003",
    emptyDraft: "92000000-0000-4000-8000-000000000004",
  } as const;
  const file = {
    id: "historical-file",
    filename: "history.txt",
    contentType: "text/plain",
    size: 42,
    objectKey: "historical-file/history.txt",
  };
  const canonicalDocument = {
    version: 1,
    parts: [{ type: "text", text: "already canonical" }],
  };
  const synthesizedDocument = {
    version: 1,
    parts: [
      {
        type: "file",
        fileId: file.id,
        filenameSnapshot: file.filename,
        contentType: file.contentType,
      },
      { type: "text", text: "legacy prompt" },
    ],
  };

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      USER_MESSAGE_BACKFILL_PREVIOUS_MIGRATION,
    );

    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
         VALUES ($1, 'user-message-backfill-user', 'user-message-backfill', 'user-message-backfill-org')`,
        [composeId],
      );
      await client.query(
        `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
         VALUES ($1, 'user-message-backfill-org', 'user-message-backfill-user', 'user-message-backfill')`,
        [composeId],
      );
      await client.query(
        `INSERT INTO "chat_threads" (
           "id",
           "user_id",
           "agent_compose_id",
           "draft_content",
           "draft_attachments"
         )
         VALUES
           ($1, 'user-message-backfill-user', $3, 'legacy prompt', $4::jsonb),
           ($2, 'user-message-backfill-user', $3, NULL, NULL)`,
        [
          threadIds.draft,
          threadIds.emptyDraft,
          composeId,
          JSON.stringify([file]),
        ],
      );
      await client.query(
        `INSERT INTO "chat_threads" (
           "id",
           "user_id",
           "agent_compose_id"
         )
         VALUES ($1, 'user-message-backfill-user', $2)`,
        [threadIds.events, composeId],
      );
      await client.query(
        `INSERT INTO "zero_agent_drafts" (
           "user_id",
           "org_id",
           "agent_id",
           "draft_content",
           "draft_attachments"
         )
         VALUES (
           'user-message-backfill-user',
           'user-message-backfill-org',
           $1,
           'legacy prompt',
           $2::jsonb
         )`,
        [composeId, JSON.stringify([file])],
      );

      const events = await client.query<{ id: string }>(
        `INSERT INTO "chat_messages" (
           "chat_thread_id",
           "role",
           "content",
           "event_type",
           "attach_file_metadata",
           "structured_prompt",
           "error",
           "automation_id"
         )
         VALUES
           ($1, 'user', 'legacy prompt', 'input.prompt', $2::jsonb, NULL, NULL, NULL),
           ($1, 'user', 'already canonical', 'input.prompt', NULL, $3::jsonb, NULL, NULL),
           ($1, 'user', 'rejected prompt', 'input.rejected', NULL, NULL, 'rejected', NULL),
           ($1, 'user', NULL, 'input.rejected', NULL, NULL, 'automation rejection', '92000000-0000-4000-8000-000000000005'),
           ($1, 'user', NULL, 'input.automation', NULL, NULL, NULL, NULL)
         RETURNING "id"`,
        [
          threadIds.events,
          JSON.stringify([file]),
          JSON.stringify(canonicalDocument),
        ],
      );
      const [
        synthesizedEvent,
        canonicalEvent,
        rejectedEvent,
        automationRejectedEvent,
        automationEvent,
      ] = events.rows.map((row) => {
        return row.id;
      });
      assert.ok(synthesizedEvent);
      assert.ok(canonicalEvent);
      assert.ok(rejectedEvent);
      assert.ok(automationRejectedEvent);
      assert.ok(automationEvent);

      await applyMigrationsUpToInTransaction(
        client,
        USER_MESSAGE_BACKFILL_MIGRATION,
      );

      const inputRows = await client.query<{
        id: string;
        userMessage: unknown;
      }>(
        `SELECT "id", "structured_prompt" AS "userMessage"
         FROM "chat_messages"
         WHERE "id" = ANY($1::uuid[])`,
        [
          [
            synthesizedEvent,
            canonicalEvent,
            rejectedEvent,
            automationRejectedEvent,
          ],
        ],
      );
      const userMessageById = new Map(
        inputRows.rows.map((row) => {
          return [row.id, row.userMessage] as const;
        }),
      );
      assert.deepEqual(
        userMessageById.get(synthesizedEvent),
        synthesizedDocument,
      );
      assert.deepEqual(userMessageById.get(canonicalEvent), canonicalDocument);
      assert.deepEqual(userMessageById.get(rejectedEvent), {
        version: 1,
        parts: [{ type: "text", text: "rejected prompt" }],
      });
      assert.deepEqual(userMessageById.get(automationRejectedEvent), {
        version: 1,
        parts: [{ type: "text", text: "automation rejection" }],
      });

      const draftRows = await client.query<{
        id: string;
        draftUserMessage: unknown;
      }>(
        `SELECT "id", "draft_structured_prompt" AS "draftUserMessage"
         FROM "chat_threads"
         WHERE "id" = ANY($1::uuid[])
         ORDER BY "id"`,
        [[threadIds.draft, threadIds.emptyDraft]],
      );
      assert.deepEqual(draftRows.rows, [
        {
          id: threadIds.draft,
          draftUserMessage: synthesizedDocument,
        },
        {
          id: threadIds.emptyDraft,
          draftUserMessage: null,
        },
      ]);
      const agentDraft = await client.query<{ draftUserMessage: unknown }>(
        `SELECT "draft_structured_prompt" AS "draftUserMessage"
         FROM "zero_agent_drafts"
         WHERE "user_id" = 'user-message-backfill-user'
           AND "org_id" = 'user-message-backfill-org'
           AND "agent_id" = $1`,
        [composeId],
      );
      assert.deepEqual(agentDraft.rows, [
        { draftUserMessage: synthesizedDocument },
      ]);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: synthesizedEvent,
      });

      await applyMigrationsUpToInTransaction(
        client,
        USER_MESSAGE_CONTRACT_MIGRATION,
      );
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chat_messages_input_user_message_check",
        query: `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content",
            "event_type"
          )
          VALUES ($1, 'user', 'missing userMessage', 'input.prompt')
        `,
        values: [threadIds.events],
      });
      await client.query(
        `INSERT INTO "chat_messages" (
           "chat_thread_id",
           "role",
           "content",
           "event_type"
         )
         VALUES ($1, 'assistant', 'output remains nullable', 'output.message')`,
        [threadIds.events],
      );
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "chat_threads_draft_user_message_check",
        query: `
          UPDATE "chat_threads"
          SET
            "draft_content" = 'missing userMessage',
            "draft_structured_prompt" = NULL
          WHERE "id" = $1
        `,
        values: [threadIds.emptyDraft],
      });
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "zero_agent_drafts_draft_user_message_check",
        query: `
          UPDATE "zero_agent_drafts"
          SET "draft_structured_prompt" = NULL
          WHERE "user_id" = 'user-message-backfill-user'
            AND "org_id" = 'user-message-backfill-org'
            AND "agent_id" = $1
        `,
        values: [composeId],
      });
      const constraints = await client.query<{
        name: string;
        validated: boolean;
      }>(
        `SELECT
           "conname" AS "name",
           "convalidated" AS "validated"
         FROM "pg_catalog"."pg_constraint"
         WHERE "conname" = ANY($1::text[])
         ORDER BY "conname"`,
        [
          [
            "chat_messages_input_user_message_check",
            "chat_threads_draft_user_message_check",
            "zero_agent_drafts_draft_user_message_check",
          ],
        ],
      );
      assert.deepEqual(constraints.rows, [
        {
          name: "chat_messages_input_user_message_check",
          validated: true,
        },
        {
          name: "chat_threads_draft_user_message_check",
          validated: true,
        },
        {
          name: "zero_agent_drafts_draft_user_message_check",
          validated: true,
        },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Historical events and drafts gain canonical documents, non-empty inputs require userMessage, and append-only protection remains active\n",
  );
}

const CANONICAL_USER_MESSAGE_PREVIOUS_MIGRATION = 727;
const CANONICAL_USER_MESSAGE_CONTRACT_MIGRATION = 730;
const CANONICAL_USER_MESSAGE_CLEANUP_PREVIOUS_MIGRATION = 738;
const CANONICAL_USER_MESSAGE_CLEANUP_MIGRATION = 739;
const DRAFT_CONTENT_CLEANUP_PREVIOUS_MIGRATION = 748;
const DRAFT_CONTENT_CONSTRAINT_ADD_MIGRATION = 749;
const DRAFT_CONTENT_CONSTRAINT_VALIDATION_MIGRATION = 750;
const DRAFT_CONTENT_CLEANUP_MIGRATION = 751;

async function validateCanonicalUserMessageRolloutCompatibility(): Promise<void> {
  console.log("=== Validate canonical userMessage rollout compatibility ===\n");

  const testDb = "migration_canonical_user_message_rollout_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    agentIds: {
      historical: "93000000-0000-4000-8000-000000000001",
      upsert: "93000000-0000-4000-8000-000000000002",
    },
    orgId: "canonical-user-message-rollout-org",
    userId: "canonical-user-message-rollout-user",
  } as const;
  const historicalDocument = {
    version: 1,
    parts: [{ type: "text", text: "historical agent draft" }],
  };
  const legacyInsertDocument = {
    version: 1,
    parts: [{ type: "text", text: "legacy API insert" }],
  };
  const legacyUpdateDocument = {
    version: 1,
    parts: [{ type: "text", text: "legacy API conflict update" }],
  };
  const canonicalUpdateDocument = {
    version: 1,
    parts: [{ type: "text", text: "canonical API conflict update" }],
  };

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CANONICAL_USER_MESSAGE_PREVIOUS_MIGRATION,
    );

    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
         VALUES
           ($1, $4, 'canonical-user-message-historical', $3),
           ($2, $4, 'canonical-user-message-upsert', $3)`,
        [
          fixture.agentIds.historical,
          fixture.agentIds.upsert,
          fixture.orgId,
          fixture.userId,
        ],
      );
      await client.query(
        `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
         VALUES
           ($1, $3, $4, 'canonical-user-message-historical'),
           ($2, $3, $4, 'canonical-user-message-upsert')`,
        [
          fixture.agentIds.historical,
          fixture.agentIds.upsert,
          fixture.orgId,
          fixture.userId,
        ],
      );
      await client.query(
        `INSERT INTO "zero_agent_drafts" (
           "user_id",
           "org_id",
           "agent_id",
           "draft_content",
           "draft_structured_prompt"
         )
         VALUES ($1, $2, $3, 'historical agent draft', $4::jsonb)`,
        [
          fixture.userId,
          fixture.orgId,
          fixture.agentIds.historical,
          JSON.stringify(historicalDocument),
        ],
      );

      await applyMigrationsUpToInTransaction(
        client,
        CANONICAL_USER_MESSAGE_CONTRACT_MIGRATION,
      );

      const historicalDraft = await client.query<{
        draftUserMessage: unknown;
        legacyDraftUserMessage: unknown;
      }>(
        `SELECT
           "draft_structured_prompt" AS "legacyDraftUserMessage",
           "draft_user_message" AS "draftUserMessage"
         FROM "zero_agent_drafts"
         WHERE "user_id" = $1
           AND "org_id" = $2
           AND "agent_id" = $3`,
        [fixture.userId, fixture.orgId, fixture.agentIds.historical],
      );
      assert.deepEqual(historicalDraft.rows, [
        {
          draftUserMessage: historicalDocument,
          legacyDraftUserMessage: historicalDocument,
        },
      ]);

      const legacyInsert = await client.query<{
        draftUserMessage: unknown;
        legacyDraftUserMessage: unknown;
      }>(
        `INSERT INTO "zero_agent_drafts" (
           "user_id",
           "org_id",
           "agent_id",
           "draft_content",
           "draft_structured_prompt",
           "updated_at"
         )
         VALUES ($1, $2, $3, 'legacy API insert', $4::jsonb, NOW())
         ON CONFLICT ("user_id", "org_id", "agent_id") DO UPDATE
         SET
           "draft_content" = EXCLUDED."draft_content",
           "draft_structured_prompt" = EXCLUDED."draft_structured_prompt",
           "updated_at" = EXCLUDED."updated_at"
         RETURNING
           "draft_structured_prompt" AS "legacyDraftUserMessage",
           "draft_user_message" AS "draftUserMessage"`,
        [
          fixture.userId,
          fixture.orgId,
          fixture.agentIds.upsert,
          JSON.stringify(legacyInsertDocument),
        ],
      );
      assert.deepEqual(legacyInsert.rows, [
        {
          draftUserMessage: legacyInsertDocument,
          legacyDraftUserMessage: legacyInsertDocument,
        },
      ]);

      const legacyUpdate = await client.query<{
        draftUserMessage: unknown;
        legacyDraftUserMessage: unknown;
      }>(
        `INSERT INTO "zero_agent_drafts" (
           "user_id",
           "org_id",
           "agent_id",
           "draft_content",
           "draft_structured_prompt",
           "updated_at"
         )
         VALUES ($1, $2, $3, 'legacy API conflict update', $4::jsonb, NOW())
         ON CONFLICT ("user_id", "org_id", "agent_id") DO UPDATE
         SET
           "draft_content" = EXCLUDED."draft_content",
           "draft_structured_prompt" = EXCLUDED."draft_structured_prompt",
           "updated_at" = EXCLUDED."updated_at"
         RETURNING
           "draft_structured_prompt" AS "legacyDraftUserMessage",
           "draft_user_message" AS "draftUserMessage"`,
        [
          fixture.userId,
          fixture.orgId,
          fixture.agentIds.upsert,
          JSON.stringify(legacyUpdateDocument),
        ],
      );
      assert.deepEqual(legacyUpdate.rows, [
        {
          draftUserMessage: legacyUpdateDocument,
          legacyDraftUserMessage: legacyUpdateDocument,
        },
      ]);

      const canonicalUpdate = await client.query<{
        draftUserMessage: unknown;
        legacyDraftUserMessage: unknown;
      }>(
        `INSERT INTO "zero_agent_drafts" (
           "user_id",
           "org_id",
           "agent_id",
           "draft_content",
           "draft_user_message",
           "updated_at"
         )
         VALUES ($1, $2, $3, 'canonical API conflict update', $4::jsonb, NOW())
         ON CONFLICT ("user_id", "org_id", "agent_id") DO UPDATE
         SET
           "draft_content" = EXCLUDED."draft_content",
           "draft_user_message" = EXCLUDED."draft_user_message",
           "updated_at" = EXCLUDED."updated_at"
         RETURNING
           "draft_structured_prompt" AS "legacyDraftUserMessage",
           "draft_user_message" AS "draftUserMessage"`,
        [
          fixture.userId,
          fixture.orgId,
          fixture.agentIds.upsert,
          JSON.stringify(canonicalUpdateDocument),
        ],
      );
      assert.deepEqual(canonicalUpdate.rows, [
        {
          draftUserMessage: canonicalUpdateDocument,
          legacyDraftUserMessage: canonicalUpdateDocument,
        },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Historical agent drafts are backfilled and legacy/canonical upserts remain synchronized\n",
  );
}

async function validateCanonicalUserMessageContraction(): Promise<void> {
  console.log("=== Validate canonical userMessage contraction ===\n");

  const testDb = "migration_canonical_user_message_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  await createDatabase(testDb);

  const blocker = new Client({ connectionString: testDbUrl });
  const migrationClient = new Client({ connectionString: testDbUrl });
  let blockerOpen = false;

  try {
    await runMigrationsUpTo(
      testDbUrl,
      CANONICAL_USER_MESSAGE_CLEANUP_PREVIOUS_MIGRATION,
    );
    await blocker.connect();
    await migrationClient.connect();

    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query(`LOCK TABLE "chat_events" IN ACCESS SHARE MODE`);

    try {
      await applyMigrationsUpToInTransaction(
        migrationClient,
        CANONICAL_USER_MESSAGE_CLEANUP_MIGRATION,
      );
      assert.fail("Canonical userMessage cleanup waited for a table lock");
    } catch (error) {
      assert.equal(databaseErrorCode(error), "55P03");
    }

    await blocker.query("ROLLBACK");
    blockerOpen = false;

    await applyMigrationsUpToInTransaction(
      migrationClient,
      CANONICAL_USER_MESSAGE_CLEANUP_MIGRATION,
    );

    const legacyColumns = await migrationClient.query<{
      column_name: string;
      table_name: string;
    }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'chat_events' AND column_name = 'structured_prompt')
          OR (
            table_name IN ('chat_threads', 'zero_agent_drafts')
            AND column_name = 'draft_structured_prompt'
          )
        )
    `);
    assert.deepEqual(legacyColumns.rows, []);

    const bridgeTriggers = await migrationClient.query<{ name: string }>(`
      SELECT tgname AS name
      FROM pg_trigger
      WHERE tgname IN (
        'bridge_chat_user_message_0727',
        'bridge_chat_thread_draft_user_message_0727',
        'bridge_agent_draft_user_message_0727'
      )
    `);
    assert.deepEqual(bridgeTriggers.rows, []);

    const bridgeFunctions = await migrationClient.query<{
      chatBridge: string | null;
      draftBridge: string | null;
    }>(`
      SELECT
        to_regprocedure('bridge_chat_user_message_0727()')::text AS "chatBridge",
        to_regprocedure('bridge_draft_user_message_0727()')::text AS "draftBridge"
    `);
    assert.deepEqual(bridgeFunctions.rows, [
      { chatBridge: null, draftBridge: null },
    ]);
  } finally {
    if (blockerOpen) {
      await blocker.query("ROLLBACK");
    }
    await blocker.end();
    await migrationClient.end();
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Cleanup fails fast on lock contention and removes only legacy userMessage storage\n",
  );
}

async function validateDraftContentContraction(): Promise<void> {
  console.log("=== Validate draftContent contraction ===\n");

  const testDb = "migration_draft_content_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    agentId: "96000000-0000-4000-8000-000000000001",
    existingThreadId: "97000000-0000-4000-8000-000000000001",
    insertedThreadId: "97000000-0000-4000-8000-000000000002",
    orgId: "draft-content-contraction-org",
    userId: "draft-content-contraction-user",
    insertedDraftUserId: "draft-content-contraction-insert-user",
  } as const;
  const canonicalDocument = JSON.stringify({
    version: 1,
    parts: [{ type: "text", text: "canonical draft" }],
  });
  await createDatabase(testDb);

  const blocker = new Client({ connectionString: testDbUrl });
  const migrationClient = new Client({ connectionString: testDbUrl });
  const trafficClient = new Client({ connectionString: testDbUrl });
  let blockerOpen = false;
  let validationOpen = false;

  try {
    await runMigrationsUpTo(
      testDbUrl,
      DRAFT_CONTENT_CLEANUP_PREVIOUS_MIGRATION,
    );
    await blocker.connect();
    await migrationClient.connect();
    await trafficClient.connect();

    await migrationClient.query(
      `INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
       VALUES ($1, $2, 'draft-content-contraction', $3)`,
      [fixture.agentId, fixture.userId, fixture.orgId],
    );
    await migrationClient.query(
      `INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
       VALUES ($1, $2, $3, 'draft-content-contraction')`,
      [fixture.agentId, fixture.orgId, fixture.userId],
    );
    await migrationClient.query(
      `INSERT INTO "chat_threads" (
         "id",
         "user_id",
         "agent_compose_id",
         "title"
       )
       VALUES ($1, $2, $3, 'existing draft thread')`,
      [fixture.existingThreadId, fixture.userId, fixture.agentId],
    );
    await migrationClient.query(
      `INSERT INTO "zero_agent_drafts" ("user_id", "org_id", "agent_id")
       VALUES ($1, $2, $3)`,
      [fixture.userId, fixture.orgId, fixture.agentId],
    );

    await applyMigrationsUpToInTransaction(
      migrationClient,
      DRAFT_CONTENT_CONSTRAINT_ADD_MIGRATION,
    );

    const migrationPidResult = await migrationClient.query<{
      pid: number;
    }>(`SELECT pg_backend_pid() AS pid`);
    const migrationPid = migrationPidResult.rows[0]?.pid;
    assert.ok(migrationPid);

    await migrationClient.query("BEGIN");
    validationOpen = true;
    await applyMigrationsUpTo(
      migrationClient,
      DRAFT_CONTENT_CONSTRAINT_VALIDATION_MIGRATION,
    );

    const validationLocks = await trafficClient.query<{
      mode: string;
      relation: string;
    }>(
      `
        SELECT
          relation::regclass::text AS relation,
          mode
        FROM pg_locks
        WHERE pid = $1
          AND granted
          AND relation IN (
            'chat_threads'::regclass,
            'zero_agent_drafts'::regclass
          )
          AND mode IN (
            'ShareUpdateExclusiveLock',
            'AccessExclusiveLock'
          )
        ORDER BY relation, mode
      `,
      [migrationPid],
    );
    assert.deepEqual(validationLocks.rows, [
      {
        mode: "ShareUpdateExclusiveLock",
        relation: "chat_threads",
      },
      {
        mode: "ShareUpdateExclusiveLock",
        relation: "zero_agent_drafts",
      },
    ]);

    // VALIDATE has completed its scans, but its transaction still holds the
    // exact table locks until commit. Ordinary traffic must remain compatible
    // with those locks without relying on validation scan timing.
    await trafficClient.query(`SET statement_timeout = '2s'`);
    const selectedThread = await trafficClient.query<{ id: string }>(
      `SELECT "id" FROM "chat_threads" WHERE "id" = $1`,
      [fixture.existingThreadId],
    );
    assert.deepEqual(selectedThread.rows, [{ id: fixture.existingThreadId }]);

    const insertedThread = await trafficClient.query<{ id: string }>(
      `INSERT INTO "chat_threads" (
         "id",
         "user_id",
         "agent_compose_id",
         "title",
         "draft_user_message"
       )
       VALUES ($1, $2, $3, 'inserted during validation', $4::jsonb)
       RETURNING "id"`,
      [
        fixture.insertedThreadId,
        fixture.userId,
        fixture.agentId,
        canonicalDocument,
      ],
    );
    assert.deepEqual(insertedThread.rows, [{ id: fixture.insertedThreadId }]);

    const insertedDraft = await trafficClient.query<{ userId: string }>(
      `INSERT INTO "zero_agent_drafts" (
         "user_id",
         "org_id",
         "agent_id",
         "draft_user_message"
       )
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING "user_id" AS "userId"`,
      [
        fixture.insertedDraftUserId,
        fixture.orgId,
        fixture.agentId,
        canonicalDocument,
      ],
    );
    assert.deepEqual(insertedDraft.rows, [
      { userId: fixture.insertedDraftUserId },
    ]);

    const updatedThread = await trafficClient.query(
      `UPDATE "chat_threads"
       SET "draft_user_message" = $2::jsonb
       WHERE "id" = $1`,
      [fixture.existingThreadId, canonicalDocument],
    );
    assert.equal(updatedThread.rowCount, 1);
    const updatedDraft = await trafficClient.query(
      `UPDATE "zero_agent_drafts"
       SET "draft_user_message" = $4::jsonb
       WHERE "user_id" = $1
         AND "org_id" = $2
         AND "agent_id" = $3`,
      [fixture.userId, fixture.orgId, fixture.agentId, canonicalDocument],
    );
    assert.equal(updatedDraft.rowCount, 1);

    await migrationClient.query("COMMIT");
    validationOpen = false;

    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query(`LOCK TABLE "chat_threads" IN ACCESS SHARE MODE`);

    try {
      await applyMigrationsUpToInTransaction(
        migrationClient,
        DRAFT_CONTENT_CLEANUP_MIGRATION,
      );
      assert.fail("draftContent cleanup waited for a table lock");
    } catch (error) {
      assert.equal(databaseErrorCode(error), "55P03");
    }

    await blocker.query("ROLLBACK");
    blockerOpen = false;

    await applyMigrationsUpToInTransaction(
      migrationClient,
      DRAFT_CONTENT_CLEANUP_MIGRATION,
    );

    const legacyColumns = await migrationClient.query<{
      column_name: string;
      table_name: string;
    }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('chat_threads', 'zero_agent_drafts')
        AND column_name = 'draft_content'
    `);
    assert.deepEqual(legacyColumns.rows, []);

    const constraints = await migrationClient.query<{
      definition: string;
      name: string;
      validated: boolean;
    }>(`
      SELECT
        constraint_record.conname AS "name",
        constraint_record.convalidated AS "validated",
        pg_get_constraintdef(constraint_record.oid) AS "definition"
      FROM pg_constraint AS constraint_record
      WHERE constraint_record.conname IN (
        'chat_threads_draft_user_message_check',
        'zero_agent_drafts_draft_user_message_check'
      )
      ORDER BY constraint_record.conname
    `);
    assert.equal(constraints.rows.length, 2);
    assert.ok(
      constraints.rows.every((constraint) => {
        return (
          constraint.validated &&
          constraint.definition.includes("draft_user_message") &&
          constraint.definition.includes("draft_attachments") &&
          !constraint.definition.includes("draft_content")
        );
      }),
    );
  } finally {
    if (validationOpen) {
      await migrationClient.query("ROLLBACK");
    }
    if (blockerOpen) {
      await blocker.query("ROLLBACK");
    }
    await blocker.end();
    await migrationClient.end();
    await trafficClient.end();
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Validation permits live reads and writes, cleanup fails fast on lock contention, and both draftContent columns are removed\n",
  );
}

const CHAT_EVENT_TYPE_PREVIOUS_MIGRATION = 696;
const CHAT_EVENT_TYPE_ADDITIVE_MIGRATION = 697;
const CHAT_EVENT_TYPE_BACKFILL_MIGRATION = 698;
const CHAT_EVENT_TYPE_CONTRACT_MIGRATION = 701;
const CHAT_EVENT_TYPE_CONSUMER_MIGRATION = 702;

async function validateChatEventTypeBackfillAndContract(): Promise<void> {
  console.log(
    "=== Validate populated ChatEvent type backfill and contract ===\n",
  );

  const testDb = "migration_chat_event_type_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, CHAT_EVENT_TYPE_PREVIOUS_MIGRATION);

    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const agentCompose = await client.query<{ id: string }>(`
        INSERT INTO "agent_composes" ("user_id", "name", "org_id")
        VALUES (
          'chat-event-backfill-user',
          'chat-event-backfill-test',
          'chat-event-backfill-org'
        )
        RETURNING "id"
      `);
      const agentComposeId = agentCompose.rows[0]?.id;
      assert.ok(agentComposeId);

      const thread = await client.query<{ id: string }>(
        `
          INSERT INTO "chat_threads" (
            "user_id",
            "agent_compose_id",
            "title"
          )
          VALUES (
            'chat-event-backfill-user',
            $1,
            'chat event backfill test'
          )
          RETURNING "id"
        `,
        [agentComposeId],
      );
      const threadId = thread.rows[0]?.id;
      assert.ok(threadId);

      const messages = await client.query<{ id: string }>(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content"
          )
          VALUES
            ($1, 'user', 'legacy prompt'),
            ($1, 'assistant', 'legacy response')
          RETURNING "id"
        `,
        [threadId],
      );
      const promptId = messages.rows[0]?.id;
      assert.ok(promptId);

      await client.query(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "structured_prompt_with_feedback",
            "revokes_message_id"
          )
          VALUES ($1, 'user', $2::jsonb, $3)
        `,
        [
          threadId,
          JSON.stringify({
            version: 1,
            parts: [
              {
                type: "feedback",
                quote: "legacy response",
                note: [{ type: "text", text: "Make this more concise" }],
              },
            ],
          }),
          promptId,
        ],
      );

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: promptId,
      });

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_TYPE_ADDITIVE_MIGRATION,
      );

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: promptId,
      });

      await client.query(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content",
            "event_type"
          )
          VALUES ($1, 'assistant', 'typed writer during rollout', 'output.message')
        `,
        [threadId],
      );

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_TYPE_BACKFILL_MIGRATION,
      );

      const classified = await client.query<{
        eventType: string | null;
        role: string;
      }>(
        `
          SELECT
            "role",
            "event_type" AS "eventType"
          FROM "chat_messages"
          WHERE "chat_thread_id" = $1
          ORDER BY "seq_id"
        `,
        [threadId],
      );
      assert.deepEqual(classified.rows, [
        { eventType: "input.prompt", role: "user" },
        { eventType: "output.message", role: "assistant" },
        { eventType: "input.prompt", role: "user" },
        { eventType: "output.message", role: "assistant" },
      ]);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: promptId,
      });

      const rolloutTailWrite = await client.query<{
        eventType: string | null;
        id: string;
      }>(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content"
          )
          VALUES ($1, 'user', 'rollout-tail writer before contract')
          RETURNING "id", "event_type" AS "eventType"
        `,
        [threadId],
      );
      const rolloutTailId = rolloutTailWrite.rows[0]?.id;
      assert.ok(rolloutTailId);
      assert.equal(rolloutTailWrite.rows[0]?.eventType, null);

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_TYPE_CONTRACT_MIGRATION,
      );

      const contractedTail = await client.query<{ eventType: string }>(
        `
          SELECT "event_type" AS "eventType"
          FROM "chat_messages"
          WHERE "id" = $1
        `,
        [rolloutTailId],
      );
      assert.equal(contractedTail.rows[0]?.eventType, "input.prompt");

      const contractState = await client.query<{
        constraintValidated: boolean;
        eventTypeNotNull: boolean;
      }>(`
        SELECT
          attribute.attnotnull AS "eventTypeNotNull",
          event_type_constraint.convalidated AS "constraintValidated"
        FROM pg_catalog.pg_attribute AS attribute
        INNER JOIN pg_catalog.pg_class AS relation
          ON relation.oid = attribute.attrelid
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        INNER JOIN pg_catalog.pg_constraint AS event_type_constraint
          ON event_type_constraint.conrelid = relation.oid
          AND event_type_constraint.conname = 'chat_messages_event_type_check'
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'chat_messages'
          AND attribute.attname = 'event_type'
      `);
      assert.deepEqual(contractState.rows, [
        { constraintValidated: true, eventTypeNotNull: true },
      ]);

      await expectDatabaseError(client, {
        code: "23502",
        query: `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content",
            "event_type"
          )
          VALUES ($1, 'user', 'NULL event type after contract', NULL)
        `,
        values: [threadId],
      });
      await expectDatabaseError(client, {
        code: "23514",
        query: `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content",
            "event_type"
          )
          VALUES ($1, 'user', 'unsupported event type after contract', 'unsupported.event')
        `,
        values: [threadId],
      });

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: rolloutTailId,
      });

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_TYPE_CONSUMER_MIGRATION,
      );

      const consumerEvents = await client.query<{
        eventType: string;
        id: string;
      }>(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content",
            "event_type",
            "automation_id",
            "trigger_source",
            "trigger_brief",
            "encrypted_params",
            "error"
          )
          VALUES
            (
              $1,
              'user',
              NULL,
              'input.automation',
              '80000000-0000-4000-8000-000000000001',
              'workflow-event',
              'Gmail label applied',
              'encrypted-queue-params',
              NULL
            ),
            (
              $1,
              'assistant',
              NULL,
              'queue.automation_paused',
              NULL,
              NULL,
              NULL,
              NULL,
              'Provider unavailable'
            ),
            (
              $1,
              'assistant',
              NULL,
              'queue.automation_resumed',
              NULL,
              NULL,
              NULL,
              NULL,
              NULL
            )
          RETURNING "id", "event_type" AS "eventType"
        `,
        [threadId],
      );
      assert.deepEqual(
        consumerEvents.rows.map(({ eventType }) => {
          return eventType;
        }),
        [
          "input.automation",
          "queue.automation_paused",
          "queue.automation_resumed",
        ],
      );

      const automationEventId = consumerEvents.rows[0]?.id;
      assert.ok(automationEventId);

      const automationPayload = await client.query<{
        automationId: string;
        encryptedParams: string;
        triggerBrief: string;
        triggerSource: string;
      }>(
        `
          SELECT
            "automation_id" AS "automationId",
            "trigger_source" AS "triggerSource",
            "trigger_brief" AS "triggerBrief",
            "encrypted_params" AS "encryptedParams"
          FROM "chat_messages"
          WHERE "id" = $1
        `,
        [automationEventId],
      );
      assert.deepEqual(automationPayload.rows[0], {
        automationId: "80000000-0000-4000-8000-000000000001",
        encryptedParams: "encrypted-queue-params",
        triggerBrief: "Gmail label applied",
        triggerSource: "workflow-event",
      });

      const consumerColumns = await client.query<{
        columnName: string;
        isNullable: string;
      }>(`
        SELECT
          column_name AS "columnName",
          is_nullable AS "isNullable"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_messages'
          AND column_name IN (
            'automation_id',
            'trigger_source',
            'trigger_brief',
            'encrypted_params'
          )
        ORDER BY column_name
      `);
      assert.deepEqual(consumerColumns.rows, [
        { columnName: "automation_id", isNullable: "YES" },
        { columnName: "encrypted_params", isNullable: "YES" },
        { columnName: "trigger_brief", isNullable: "YES" },
        { columnName: "trigger_source", isNullable: "YES" },
      ]);

      const consumerIndexes = await client.query<{ indexName: string }>(`
        SELECT indexname AS "indexName"
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'chat_messages'
          AND indexname IN (
            'chat_messages_input_automation_idx',
            'chat_messages_pending_queue_idx',
            'chat_messages_automation_pause_idx'
          )
        ORDER BY indexname
      `);
      assert.deepEqual(consumerIndexes.rows, [
        { indexName: "chat_messages_automation_pause_idx" },
        { indexName: "chat_messages_input_automation_idx" },
        { indexName: "chat_messages_pending_queue_idx" },
      ]);

      const consumerConstraint = await client.query<{
        constraintValidated: boolean;
      }>(`
        SELECT convalidated AS "constraintValidated"
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.chat_messages'::regclass
          AND conname = 'chat_messages_event_type_check'
      `);
      assert.deepEqual(consumerConstraint.rows, [
        { constraintValidated: true },
      ]);

      await expectDatabaseError(client, {
        code: "23514",
        query: `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "role",
            "content",
            "event_type"
          )
          VALUES ($1, 'user', 'unsupported event type after expansion', 'unsupported.event')
        `,
        values: [threadId],
      });
      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "trigger_brief" = 'mutated' WHERE "id" = $1`,
        rowId: automationEventId,
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Rollout-tail rows are classified, automation queue leaves are accepted, and append-only protection remains active\n",
  );
}

const CHAT_EVENT_QUEUE_CONTRACTION_PREVIOUS_MIGRATION = 718;
const CHAT_EVENT_QUEUE_CONTRACTION_MIGRATION = 719;
const CHAT_EVENT_QUEUE_COMPATIBILITY_VIEW_DROP_MIGRATION = 721;

async function validateChatEventQueueContraction(): Promise<void> {
  console.log("=== Validate ChatEvent queue schema contraction ===\n");

  const testDb = "migration_chat_event_queue_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "93000000-0000-4000-8000-000000000001";
  const threadId = "93000000-0000-4000-8000-000000000002";
  const promptId = "93000000-0000-4000-8000-000000000003";
  const legacyQueueId = "93000000-0000-4000-8000-000000000004";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CHAT_EVENT_QUEUE_CONTRACTION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'chat-event-queue-contraction-user',
            'chat-event-queue-contraction',
            'chat-event-queue-contraction-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id"
          )
          VALUES (
            $1,
            'chat-event-queue-contraction-user',
            $2
          )
        `,
        [threadId, composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_messages" (
            "id",
            "chat_thread_id",
            "run_id",
            "event_type",
            "role",
            "content",
            "structured_prompt"
          )
          VALUES (
            $1,
            $2,
            NULL,
            'input.prompt',
            'user',
            'pending canonical prompt',
            '{
              "version": 1,
              "parts": [
                {"type": "text", "text": "pending canonical prompt"}
              ]
            }'::jsonb
          )
        `,
        [promptId, threadId],
      );
      await client.query(
        `
          INSERT INTO "chat_message_queue" (
            "id",
            "org_id",
            "user_id",
            "chat_thread_id",
            "item_type",
            "chat_message_id",
            "encrypted_params"
          )
          VALUES (
            $1,
            'chat-event-queue-contraction-org',
            'chat-event-queue-contraction-user',
            $2,
            'slack_user_message',
            $3,
            'legacy-overlap-ciphertext'
          )
        `,
        [legacyQueueId, threadId, promptId],
      );
      const mirroredPayload = await client.query<{
        encryptedParams: string;
        triggerSource: string;
      }>(
        `
          SELECT
            "encrypted_params" AS "encryptedParams",
            "trigger_source" AS "triggerSource"
          FROM "chat_messages"
          WHERE "id" = $1
        `,
        [promptId],
      );
      assert.deepEqual(mirroredPayload.rows, [
        {
          encryptedParams: "legacy-overlap-ciphertext",
          triggerSource: "slack",
        },
      ]);
      await client.query(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "run_id",
            "event_type",
            "role",
            "content",
            "error"
          )
          VALUES (
            $1,
            NULL,
            'queue.automation_paused',
            'assistant',
            NULL,
            'contraction fixture pause'
          )
        `,
        [threadId],
      );

      const projectedPause = await client.query<{
        pauseReason: string;
        queuePausedAt: Date;
      }>(
        `
          SELECT
            "queue_paused_at" AS "queuePausedAt",
            "pause_reason" AS "pauseReason"
          FROM "chat_threads"
          WHERE "id" = $1
        `,
        [threadId],
      );
      assert.equal(
        projectedPause.rows[0]?.pauseReason,
        "contraction fixture pause",
      );
      assert.ok(projectedPause.rows[0]?.queuePausedAt instanceof Date);

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_QUEUE_CONTRACTION_MIGRATION,
      );

      const retiredSchema = await client.query<{
        compatibilityDeleteFunction: string | null;
        compatibilityRelationKind: string | null;
        compatibilityView: string | null;
        legacyColumnCount: number;
        legacyDeleteFunction: string | null;
        legacyEnum: string | null;
        legacyInsertFunction: string | null;
        legacyPauseFunction: string | null;
        legacyPauseProjectionFunction: string | null;
        legacyTableCount: number;
      }>(`
        SELECT
          to_regclass('public.chat_message_queue')::text
            AS "compatibilityView",
          (
            SELECT relation.relkind::text
            FROM pg_class AS relation
            INNER JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname = 'chat_message_queue'
          ) AS "compatibilityRelationKind",
          to_regprocedure(
            'ignore_legacy_chat_message_queue_delete_0719()'
          )::text AS "compatibilityDeleteFunction",
          to_regtype('public.chat_message_queue_item_type')::text
            AS "legacyEnum",
          (
            SELECT COUNT(*)::integer
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'chat_message_queue'
              AND table_type = 'BASE TABLE'
          ) AS "legacyTableCount",
          (
            SELECT COUNT(*)::integer
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'chat_threads'
              AND column_name IN ('queue_paused_at', 'pause_reason')
          ) AS "legacyColumnCount",
          to_regprocedure(
            'mirror_legacy_chat_queue_insert_0714()'
          )::text AS "legacyInsertFunction",
          to_regprocedure(
            'mirror_legacy_chat_queue_delete_0714()'
          )::text AS "legacyDeleteFunction",
          to_regprocedure(
            'project_chat_queue_pause_event_0714()'
          )::text AS "legacyPauseProjectionFunction",
          to_regprocedure(
            'mirror_legacy_chat_queue_pause_0714()'
          )::text AS "legacyPauseFunction"
      `);
      assert.deepEqual(retiredSchema.rows, [
        {
          compatibilityDeleteFunction:
            "ignore_legacy_chat_message_queue_delete_0719()",
          compatibilityRelationKind: "v",
          compatibilityView: "chat_message_queue",
          legacyColumnCount: 0,
          legacyDeleteFunction: null,
          legacyEnum: null,
          legacyInsertFunction: null,
          legacyPauseFunction: null,
          legacyPauseProjectionFunction: null,
          legacyTableCount: 0,
        },
      ]);

      const legacyUserDelete = await client.query(
        `
          DELETE FROM "chat_message_queue"
          WHERE "chat_thread_id" = $1
            AND "chat_message_id" = $2
            AND "item_type" IN ($3, $4, $5, $6)
        `,
        [
          threadId,
          promptId,
          "user_message",
          "slack_user_message",
          "feishu_user_message",
          "teams_user_message",
        ],
      );
      assert.equal(legacyUserDelete.rowCount, 0);

      const legacyWorkflowDelete = await client.query(
        `
          DELETE FROM "chat_message_queue"
          WHERE "id" = $1
            AND "chat_thread_id" = $2
            AND "item_type" = $3
        `,
        [legacyQueueId, threadId, "workflow_event"],
      );
      assert.equal(legacyWorkflowDelete.rowCount, 0);

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_QUEUE_COMPATIBILITY_VIEW_DROP_MIGRATION,
      );

      const retiredCompatibilityView = await client.query<{
        compatibilityDeleteFunction: string | null;
        compatibilityTriggerCount: number;
        compatibilityView: string | null;
      }>(`
        SELECT
          to_regclass('public.chat_message_queue')::text
            AS "compatibilityView",
          to_regprocedure(
            'ignore_legacy_chat_message_queue_delete_0719()'
          )::text AS "compatibilityDeleteFunction",
          (
            SELECT COUNT(*)::integer
            FROM pg_trigger
            WHERE tgname = 'ignore_legacy_chat_message_queue_delete_0719'
              AND NOT tgisinternal
          ) AS "compatibilityTriggerCount"
      `);
      assert.deepEqual(retiredCompatibilityView.rows, [
        {
          compatibilityDeleteFunction: null,
          compatibilityTriggerCount: 0,
          compatibilityView: null,
        },
      ]);

      const canonicalEvents = await client.query<{
        content: string | null;
        encryptedParams: string | null;
        eventType: string;
        triggerSource: string | null;
      }>(
        `
          SELECT
            "content",
            "encrypted_params" AS "encryptedParams",
            "event_type" AS "eventType",
            "trigger_source" AS "triggerSource"
          FROM "chat_messages"
          WHERE "chat_thread_id" = $1
          ORDER BY "seq_id"
        `,
        [threadId],
      );
      assert.deepEqual(canonicalEvents.rows, [
        {
          content: "pending canonical prompt",
          encryptedParams: "legacy-overlap-ciphertext",
          eventType: "input.prompt",
          triggerSource: "slack",
        },
        {
          content: null,
          encryptedParams: null,
          eventType: "queue.automation_paused",
          triggerSource: null,
        },
      ]);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "trigger_source" = 'slack' WHERE "id" = $1`,
        rowId: promptId,
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Canonical queue events survive while one-release DELETE compatibility is verified and then fully retired\n",
  );
}

const CHAT_MESSAGE_ROLE_CONTRACTION_PREVIOUS_MIGRATION = 721;
const CHAT_MESSAGE_ROLE_CONTRACTION_MIGRATION = 722;

async function validateChatMessageRoleContraction(): Promise<void> {
  console.log("=== Validate populated chat message role contraction ===\n");

  const testDb = "migration_chat_message_role_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "94000000-0000-4000-8000-000000000001";
  const threadId = "94000000-0000-4000-8000-000000000002";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CHAT_MESSAGE_ROLE_CONTRACTION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'chat-message-role-contraction-user',
            'chat-message-role-contraction',
            'chat-message-role-contraction-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id"
          )
          VALUES (
            $1,
            'chat-message-role-contraction-user',
            $2
          )
        `,
        [threadId, composeId],
      );
      const historicalEvents = await client.query<{ id: string }>(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "event_type",
            "role",
            "content",
            "structured_prompt"
          )
          VALUES
            (
              $1,
              'input.prompt',
              'user',
              'historical prompt',
              '{
                "version": 1,
                "parts": [
                  {"type": "text", "text": "historical prompt"}
                ]
              }'::jsonb
            ),
            (
              $1,
              'output.message',
              'assistant',
              'historical response',
              NULL
            )
          RETURNING "id"
        `,
        [threadId],
      );
      const historicalPromptId = historicalEvents.rows[0]?.id;
      assert.ok(historicalPromptId);

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_MESSAGE_ROLE_CONTRACTION_MIGRATION,
      );

      const roleColumn = await client.query<{ columnName: string }>(`
        SELECT column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_messages'
          AND column_name = 'role'
      `);
      assert.deepEqual(roleColumn.rows, []);

      const persistedEvents = await client.query<{
        content: string;
        eventType: string;
      }>(
        `
          SELECT
            "content",
            "event_type" AS "eventType"
          FROM "chat_messages"
          WHERE "chat_thread_id" = $1
          ORDER BY "seq_id"
        `,
        [threadId],
      );
      assert.deepEqual(persistedEvents.rows, [
        { content: "historical prompt", eventType: "input.prompt" },
        { content: "historical response", eventType: "output.message" },
      ]);

      await client.query(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "event_type",
            "content"
          )
          VALUES ($1, 'output.message', 'post-migration response')
        `,
        [threadId],
      );

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: historicalPromptId,
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Historical events survive role removal, canonical inserts continue, and append-only protection remains active\n",
  );
}

const CHAT_EVENT_TABLE_RENAME_PREVIOUS_MIGRATION = 722;
const CHAT_EVENT_TABLE_RENAME_MIGRATION = 723;
const CHAT_MESSAGES_VIEW_CONTRACTION_MIGRATION = 736;

async function validateChatEventTableRename(): Promise<void> {
  console.log(
    "=== Validate populated chat event table rename and compatibility view ===\n",
  );

  const testDb = "migration_chat_event_table_rename_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "95000000-0000-4000-8000-000000000001";
  const threadId = "95000000-0000-4000-8000-000000000002";
  const artifactFileId = "95000000-0000-4000-8000-000000000003";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CHAT_EVENT_TABLE_RENAME_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'chat-event-table-rename-user',
            'chat-event-table-rename',
            'chat-event-table-rename-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id"
          )
          VALUES (
            $1,
            'chat-event-table-rename-user',
            $2
          )
        `,
        [threadId, composeId],
      );
      const historicalEvent = await client.query<{ id: string }>(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "event_type",
            "content"
          )
          VALUES ($1, 'output.message', 'historical response')
          RETURNING "id"
        `,
        [threadId],
      );
      const historicalEventId = historicalEvent.rows[0]?.id;
      assert.ok(historicalEventId);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_messages",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: historicalEventId,
      });

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_TABLE_RENAME_MIGRATION,
      );

      const relations = await client.query<{
        relationKind: string;
        relationName: string;
      }>(`
        SELECT
          "relname" AS "relationName",
          "relkind"::text AS "relationKind"
        FROM "pg_class"
        INNER JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = 'public'
          AND "pg_class"."relname" IN ('chat_events', 'chat_messages')
        ORDER BY "pg_class"."relname"
      `);
      assert.deepEqual(relations.rows, [
        { relationKind: "r", relationName: "chat_events" },
        { relationKind: "v", relationName: "chat_messages" },
      ]);

      const compatibilityView = await client.query<{
        isInsertableInto: string;
        isUpdatable: string;
      }>(`
        SELECT
          "is_insertable_into" AS "isInsertableInto",
          "is_updatable" AS "isUpdatable"
        FROM "information_schema"."views"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_messages'
      `);
      assert.deepEqual(compatibilityView.rows, [
        { isInsertableInto: "YES", isUpdatable: "YES" },
      ]);

      const renamedObjects = await client.query<{
        assetForeignKey: string | null;
        eventTypeCheck: string | null;
        primaryKeyIndex: string | null;
        queueIndex: string | null;
        rejectUpdateTrigger: string | null;
        threadForeignKey: string | null;
      }>(`
        SELECT
          to_regclass('public.chat_events_pkey')::text AS "primaryKeyIndex",
          to_regclass('public.chat_events_pending_queue_idx')::text
            AS "queueIndex",
          (
            SELECT "conname"
            FROM "pg_constraint"
            WHERE "conname" = 'chat_events_chat_thread_id_chat_threads_id_fk'
          ) AS "threadForeignKey",
          (
            SELECT "conname"
            FROM "pg_constraint"
            WHERE "conname" = 'chat_events_event_type_check'
          ) AS "eventTypeCheck",
          (
            SELECT "conname"
            FROM "pg_constraint"
            WHERE "conname" =
              'chat_message_asset_refs_chat_message_id_chat_events_id_fk'
          ) AS "assetForeignKey",
          (
            SELECT "tgname"
            FROM "pg_trigger"
            WHERE "tgname" = 'chat_events_reject_update'
              AND NOT "tgisinternal"
          ) AS "rejectUpdateTrigger"
      `);
      assert.deepEqual(renamedObjects.rows, [
        {
          assetForeignKey:
            "chat_message_asset_refs_chat_message_id_chat_events_id_fk",
          eventTypeCheck: "chat_events_event_type_check",
          primaryKeyIndex: "chat_events_pkey",
          queueIndex: "chat_events_pending_queue_idx",
          rejectUpdateTrigger: "chat_events_reject_update",
          threadForeignKey: "chat_events_chat_thread_id_chat_threads_id_fk",
        },
      ]);

      const oldPhysicalObjectNames = await client.query<{ name: string }>(`
        SELECT "name"
        FROM (
          SELECT "indexname" AS "name"
          FROM "pg_indexes"
          WHERE "schemaname" = 'public'
          UNION ALL
          SELECT "conname" AS "name"
          FROM "pg_constraint"
          WHERE "contype" <> 'n'
          UNION ALL
          SELECT "tgname" AS "name"
          FROM "pg_trigger"
          WHERE NOT "tgisinternal"
          UNION ALL
          SELECT "proname" AS "name"
          FROM "pg_proc"
          INNER JOIN "pg_namespace"
            ON "pg_namespace"."oid" = "pg_proc"."pronamespace"
          WHERE "pg_namespace"."nspname" = 'public'
        ) AS "physical_objects"
        WHERE "name" LIKE '%chat_messages%'
        ORDER BY "name"
      `);
      assert.deepEqual(oldPhysicalObjectNames.rows, []);

      const historicalRows = await client.query<{
        content: string;
        eventType: string;
        id: string;
      }>(
        `
          SELECT
            "id",
            "event_type" AS "eventType",
            "content"
          FROM "chat_messages"
          WHERE "chat_thread_id" = $1
        `,
        [threadId],
      );
      assert.deepEqual(historicalRows.rows, [
        {
          content: "historical response",
          eventType: "output.message",
          id: historicalEventId,
        },
      ]);

      const previousApiInsert = await client.query<{
        chatThreadId: string;
        content: string;
        eventType: string;
        id: string;
        seqId: string;
      }>(
        `
          INSERT INTO "chat_messages" (
            "chat_thread_id",
            "event_type",
            "content"
          )
          VALUES ($1, 'output.message', 'previous API response')
          RETURNING
            "id",
            "chat_thread_id" AS "chatThreadId",
            "event_type" AS "eventType",
            "content",
            "seq_id" AS "seqId"
        `,
        [threadId],
      );
      const previousApiEventId = previousApiInsert.rows[0]?.id;
      assert.ok(previousApiEventId);
      assert.deepEqual(previousApiInsert.rows, [
        {
          chatThreadId: threadId,
          content: "previous API response",
          eventType: "output.message",
          id: previousApiEventId,
          seqId: "2",
        },
      ]);

      const currentApiInsert = await client.query<{
        id: string;
        seqId: string;
      }>(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "event_type",
            "content"
          )
          VALUES ($1, 'output.message', 'current API response')
          RETURNING "id", "seq_id" AS "seqId"
        `,
        [threadId],
      );
      assert.ok(currentApiInsert.rows[0]?.id);
      assert.equal(currentApiInsert.rows[0]?.seqId, "3");

      const compatibilityRows = await client.query<{
        content: string;
        seqId: string;
      }>(
        `
          SELECT "content", "seq_id" AS "seqId"
          FROM "chat_messages"
          WHERE "chat_thread_id" = $1
          ORDER BY "seq_id"
        `,
        [threadId],
      );
      const physicalRows = await client.query<{
        content: string;
        seqId: string;
      }>(
        `
          SELECT "content", "seq_id" AS "seqId"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
          ORDER BY "seq_id"
        `,
        [threadId],
      );
      assert.deepEqual(compatibilityRows.rows, [
        { content: "historical response", seqId: "1" },
        { content: "previous API response", seqId: "2" },
        { content: "current API response", seqId: "3" },
      ]);
      assert.deepEqual(physicalRows.rows, compatibilityRows.rows);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: historicalEventId,
      });
      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `UPDATE "chat_events" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: historicalEventId,
      });

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_MESSAGES_VIEW_CONTRACTION_MIGRATION,
      );

      const contractedRelations = await client.query<{
        relationKind: string;
        relationName: string;
      }>(`
        SELECT
          "relname" AS "relationName",
          "relkind"::text AS "relationKind"
        FROM "pg_class"
        INNER JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = 'public'
          AND "pg_class"."relname" IN ('chat_events', 'chat_messages')
        ORDER BY "pg_class"."relname"
      `);
      assert.deepEqual(contractedRelations.rows, [
        { relationKind: "r", relationName: "chat_events" },
      ]);

      const lingeringFunctionDependencies = await client.query<{
        functionName: string;
      }>(`
        SELECT "pg_proc"."proname" AS "functionName"
        FROM "pg_proc"
        INNER JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "pg_proc"."pronamespace"
        WHERE "pg_namespace"."nspname" = 'public'
          AND "pg_proc"."prokind" IN ('f', 'p')
          AND pg_get_functiondef("pg_proc"."oid") ILIKE '%chat_messages%'
        ORDER BY "pg_proc"."proname"
      `);
      assert.deepEqual(lingeringFunctionDependencies.rows, []);

      await client.query(
        `
          INSERT INTO "run_uploaded_files" (
            "id",
            "chat_thread_id",
            "source",
            "external_id",
            "user_id",
            "org_id",
            "url"
          )
          VALUES (
            $1,
            $2,
            'web',
            'post-contract-artifact',
            'chat-event-table-rename-user',
            'chat-event-table-rename-org',
            'https://example.com/post-contract-artifact'
          )
        `,
        [artifactFileId, threadId],
      );
      const queuedArtifact = await client.query<{
        authorUserId: string;
      }>(
        `
          SELECT "author_user_id" AS "authorUserId"
          FROM "artifact_catalog_pending_files"
          WHERE "file_id" = $1
        `,
        [artifactFileId],
      );
      assert.deepEqual(queuedArtifact.rows, [
        { authorUserId: "chat-event-table-rename-user" },
      ]);

      const contractedRows = await client.query<{
        content: string;
        seqId: string;
      }>(
        `
          SELECT "content", "seq_id" AS "seqId"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
          ORDER BY "seq_id"
        `,
        [threadId],
      );
      assert.deepEqual(contractedRows.rows, physicalRows.rows);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `UPDATE "chat_events" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: historicalEventId,
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Historical rows survive the rename and compatibility-view contraction, previous-API access remains compatible through the expand step, and append-only protection stays active\n",
  );
}

const CHAT_INPUT_GOAL_PREVIOUS_MIGRATION = 723;
const CHAT_INPUT_GOAL_MIGRATION = 724;

async function validateChatInputGoalEvent(): Promise<void> {
  console.log("=== Validate dedicated input.goal queue event ===\n");

  const testDb = "migration_chat_input_goal_event_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "96000000-0000-4000-8000-000000000001";
  const threadId = "96000000-0000-4000-8000-000000000002";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, CHAT_INPUT_GOAL_PREVIOUS_MIGRATION);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'chat-input-goal-event-user',
            'chat-input-goal-event',
            'chat-input-goal-event-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id"
          )
          VALUES (
            $1,
            'chat-input-goal-event-user',
            $2
          )
        `,
        [threadId, composeId],
      );

      await expectDatabaseError(client, {
        code: "23514",
        query: `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "event_type",
            "encrypted_params"
          )
          VALUES ($1, 'input.goal', 'pre-migration-goal-params')
        `,
        values: [threadId],
      });

      await applyMigrationsUpToInTransaction(client, CHAT_INPUT_GOAL_MIGRATION);

      const goalEvent = await client.query<{ id: string }>(
        `
          INSERT INTO "chat_events" (
            "chat_thread_id",
            "event_type",
            "encrypted_params"
          )
          VALUES ($1, 'input.goal', 'post-migration-goal-params')
          RETURNING "id"
        `,
        [threadId],
      );
      const goalEventId = goalEvent.rows[0]?.id;
      assert.ok(goalEventId);

      const queueIndex = await client.query<{ indexDefinition: string }>(`
        SELECT indexdef AS "indexDefinition"
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'chat_events'
          AND indexname = 'chat_events_pending_queue_idx'
      `);
      assert.equal(queueIndex.rows.length, 1);
      assert.ok(
        queueIndex.rows[0]?.indexDefinition.includes("'input.goal'::text"),
      );

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `UPDATE "chat_events" SET "content" = 'mutated' WHERE "id" = $1`,
        rowId: goalEventId,
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ input.goal is admitted only after migration 0724, remains queue-indexed, and preserves append-only protection\n",
  );
}

const CHAT_EVENT_ASSET_REF_TABLE_RENAME_PREVIOUS_MIGRATION = 724;
const CHAT_EVENT_ASSET_REF_TABLE_RENAME_MIGRATION = 725;
const CHAT_EVENT_ASSET_REF_VIEW_CONTRACTION_MIGRATION = 740;

async function validateChatEventAssetRefTableRename(): Promise<void> {
  console.log(
    "=== Validate populated chat event asset ref table rename and compatibility view ===\n",
  );

  const testDb = "migration_chat_event_asset_ref_table_rename_test";
  const testDbUrl = createTestDbUrl(testDb);
  const composeId = "97000000-0000-4000-8000-000000000001";
  const threadId = "97000000-0000-4000-8000-000000000002";
  const eventId = "97000000-0000-4000-8000-000000000003";
  const historicalAssetId = "97000000-0000-4000-8000-000000000004";
  const previousApiAssetId = "97000000-0000-4000-8000-000000000005";
  const currentApiAssetId = "97000000-0000-4000-8000-000000000006";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CHAT_EVENT_ASSET_REF_TABLE_RENAME_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'chat-event-asset-ref-rename-user',
            'chat-event-asset-ref-rename',
            'chat-event-asset-ref-rename-org'
          )
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id",
            "user_id",
            "agent_compose_id"
          )
          VALUES (
            $1,
            'chat-event-asset-ref-rename-user',
            $2
          )
        `,
        [threadId, composeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "content"
          )
          VALUES ($1, $2, 'output.message', 'asset ref rename event')
        `,
        [eventId, threadId],
      );
      await client.query(
        `
          INSERT INTO "run_uploaded_files" (
            "id",
            "source",
            "external_id",
            "user_id"
          )
          VALUES
            (
              $1,
              'web',
              'historical-asset',
              'chat-event-asset-ref-rename-user'
            ),
            (
              $2,
              'web',
              'previous-api-asset',
              'chat-event-asset-ref-rename-user'
            ),
            (
              $3,
              'web',
              'current-api-asset',
              'chat-event-asset-ref-rename-user'
            )
        `,
        [historicalAssetId, previousApiAssetId, currentApiAssetId],
      );
      await client.query(
        `
          INSERT INTO "chat_message_asset_refs" (
            "chat_message_id",
            "asset_id",
            "position"
          )
          VALUES ($1, $2, 0)
        `,
        [eventId, historicalAssetId],
      );

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_ASSET_REF_TABLE_RENAME_MIGRATION,
      );

      const relations = await client.query<{
        relationKind: string;
        relationName: string;
      }>(`
        SELECT
          "relname" AS "relationName",
          "relkind"::text AS "relationKind"
        FROM "pg_class"
        INNER JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = 'public'
          AND "pg_class"."relname" IN (
            'chat_event_asset_refs',
            'chat_message_asset_refs'
          )
        ORDER BY "pg_class"."relname"
      `);
      assert.deepEqual(relations.rows, [
        { relationKind: "r", relationName: "chat_event_asset_refs" },
        { relationKind: "v", relationName: "chat_message_asset_refs" },
      ]);

      const compatibilityView = await client.query<{
        isInsertableInto: string;
        isUpdatable: string;
      }>(`
        SELECT
          "is_insertable_into" AS "isInsertableInto",
          "is_updatable" AS "isUpdatable"
        FROM "information_schema"."views"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_message_asset_refs'
      `);
      assert.deepEqual(compatibilityView.rows, [
        { isInsertableInto: "YES", isUpdatable: "YES" },
      ]);

      const physicalColumns = await client.query<{ columnName: string }>(`
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_event_asset_refs'
        ORDER BY "column_name"
      `);
      assert.deepEqual(physicalColumns.rows, [
        { columnName: "asset_id" },
        { columnName: "chat_event_id" },
        { columnName: "created_at" },
        { columnName: "position" },
      ]);

      const compatibilityColumns = await client.query<{
        columnName: string;
      }>(`
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_message_asset_refs'
        ORDER BY "column_name"
      `);
      assert.deepEqual(compatibilityColumns.rows, [
        { columnName: "asset_id" },
        { columnName: "chat_event_id" },
        { columnName: "chat_message_id" },
        { columnName: "created_at" },
        { columnName: "position" },
      ]);

      const renamedObjects = await client.query<{
        assetForeignKey: string | null;
        assetIndex: string | null;
        eventForeignKey: string | null;
        positionIndex: string | null;
        primaryKeyIndex: string | null;
      }>(`
        SELECT
          to_regclass('public.chat_event_asset_refs_pk')::text
            AS "primaryKeyIndex",
          to_regclass(
            'public.chat_event_asset_refs_event_position_unique'
          )::text AS "positionIndex",
          to_regclass('public.chat_event_asset_refs_asset_idx')::text
            AS "assetIndex",
          (
            SELECT "conname"
            FROM "pg_constraint"
            WHERE "conname" =
              'chat_event_asset_refs_chat_event_id_chat_events_id_fk'
          ) AS "eventForeignKey",
          (
            SELECT "conname"
            FROM "pg_constraint"
            WHERE "conname" =
              'chat_event_asset_refs_asset_id_run_uploaded_files_id_fk'
          ) AS "assetForeignKey"
      `);
      assert.deepEqual(renamedObjects.rows, [
        {
          assetForeignKey:
            "chat_event_asset_refs_asset_id_run_uploaded_files_id_fk",
          assetIndex: "chat_event_asset_refs_asset_idx",
          eventForeignKey:
            "chat_event_asset_refs_chat_event_id_chat_events_id_fk",
          positionIndex: "chat_event_asset_refs_event_position_unique",
          primaryKeyIndex: "chat_event_asset_refs_pk",
        },
      ]);

      const oldPhysicalObjectNames = await client.query<{ name: string }>(`
        SELECT "name"
        FROM (
          SELECT "indexname" AS "name"
          FROM "pg_indexes"
          WHERE "schemaname" = 'public'
          UNION ALL
          SELECT "conname" AS "name"
          FROM "pg_constraint"
          WHERE "contype" <> 'n'
        ) AS "physical_objects"
        WHERE "name" LIKE 'chat_message_asset_refs%'
        ORDER BY "name"
      `);
      assert.deepEqual(oldPhysicalObjectNames.rows, []);

      const historicalRows = await client.query<{
        assetId: string;
        chatMessageId: string;
        position: number;
      }>(
        `
          SELECT
            "chat_message_id" AS "chatMessageId",
            "asset_id" AS "assetId",
            "position"
          FROM "chat_message_asset_refs"
          WHERE "chat_message_id" = $1
        `,
        [eventId],
      );
      assert.deepEqual(historicalRows.rows, [
        {
          assetId: historicalAssetId,
          chatMessageId: eventId,
          position: 0,
        },
      ]);

      const previousApiInsertSql = `
        INSERT INTO "chat_message_asset_refs" (
          "chat_message_id",
          "asset_id",
          "position"
        )
        VALUES ($1, $2, 1)
        ON CONFLICT DO NOTHING
        RETURNING
          "chat_message_id" AS "chatMessageId",
          "asset_id" AS "assetId",
          "position"
      `;
      type PreviousApiInsertRow = {
        assetId: string;
        chatMessageId: string;
        position: number;
      };
      const previousApiInsert = await client.query<PreviousApiInsertRow>(
        previousApiInsertSql,
        [eventId, previousApiAssetId],
      );
      assert.deepEqual(previousApiInsert.rows, [
        {
          assetId: previousApiAssetId,
          chatMessageId: eventId,
          position: 1,
        },
      ]);
      const duplicatePreviousApiInsert =
        await client.query<PreviousApiInsertRow>(previousApiInsertSql, [
          eventId,
          previousApiAssetId,
        ]);
      assert.deepEqual(duplicatePreviousApiInsert.rows, []);

      const currentApiInsert = await client.query<{
        assetId: string;
        chatEventId: string;
        position: number;
      }>(
        `
          INSERT INTO "chat_event_asset_refs" (
            "chat_event_id",
            "asset_id",
            "position"
          )
          VALUES ($1, $2, 2)
          RETURNING
            "chat_event_id" AS "chatEventId",
            "asset_id" AS "assetId",
            "position"
        `,
        [eventId, currentApiAssetId],
      );
      assert.deepEqual(currentApiInsert.rows, [
        {
          assetId: currentApiAssetId,
          chatEventId: eventId,
          position: 2,
        },
      ]);

      const previousApiDelete = await client.query<{
        assetId: string;
        chatMessageId: string;
      }>(
        `
          DELETE FROM "chat_message_asset_refs"
          WHERE "chat_message_id" = $1
            AND "asset_id" = $2
          RETURNING
            "chat_message_id" AS "chatMessageId",
            "asset_id" AS "assetId"
        `,
        [eventId, previousApiAssetId],
      );
      assert.deepEqual(previousApiDelete.rows, [
        {
          assetId: previousApiAssetId,
          chatMessageId: eventId,
        },
      ]);

      const compatibilityRows = await client.query<{
        assetId: string;
        chatMessageId: string;
        position: number;
      }>(
        `
          SELECT
            "chat_message_id" AS "chatMessageId",
            "asset_id" AS "assetId",
            "position"
          FROM "chat_message_asset_refs"
          ORDER BY "position"
        `,
      );
      const physicalRows = await client.query<{
        assetId: string;
        chatMessageId: string;
        position: number;
      }>(
        `
          SELECT
            "chat_event_id" AS "chatMessageId",
            "asset_id" AS "assetId",
            "position"
          FROM "chat_event_asset_refs"
          ORDER BY "position"
        `,
      );
      assert.deepEqual(compatibilityRows.rows, [
        {
          assetId: historicalAssetId,
          chatMessageId: eventId,
          position: 0,
        },
        {
          assetId: currentApiAssetId,
          chatMessageId: eventId,
          position: 2,
        },
      ]);
      assert.deepEqual(physicalRows.rows, compatibilityRows.rows);

      await applyMigrationsUpToInTransaction(
        client,
        CHAT_EVENT_ASSET_REF_VIEW_CONTRACTION_MIGRATION,
      );

      const contractedRelations = await client.query<{
        relationKind: string;
        relationName: string;
      }>(`
        SELECT
          "relname" AS "relationName",
          "relkind"::text AS "relationKind"
        FROM "pg_class"
        INNER JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = 'public'
          AND "pg_class"."relname" IN (
            'chat_event_asset_refs',
            'chat_message_asset_refs'
          )
        ORDER BY "pg_class"."relname"
      `);
      assert.deepEqual(contractedRelations.rows, [
        { relationKind: "r", relationName: "chat_event_asset_refs" },
      ]);

      const contractedPhysicalColumns = await client.query<{
        columnName: string;
      }>(`
        SELECT "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_event_asset_refs'
        ORDER BY "column_name"
      `);
      assert.deepEqual(contractedPhysicalColumns.rows, physicalColumns.rows);

      const contractedRows = await client.query<{
        assetId: string;
        chatMessageId: string;
        position: number;
      }>(
        `
          SELECT
            "chat_event_id" AS "chatMessageId",
            "asset_id" AS "assetId",
            "position"
          FROM "chat_event_asset_refs"
          ORDER BY "position"
        `,
      );
      assert.deepEqual(contractedRows.rows, physicalRows.rows);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Historical refs survive the rename and compatibility-view contraction, previous-API access remains compatible through the expand step, and the physical table and aliased schema column stay intact\n",
  );
}

const CHAT_EVENT_PROPERTY_COLUMNS_PREVIOUS_MIGRATION = 754;
const REVOKES_EVENT_ID_EXPANSION_MIGRATION = 755;
const LAST_CHAT_EVENT_SEQ_ID_EXPANSION_MIGRATION = 756;
const FIRST_ASSISTANT_EVENT_ACK_EXPANSION_MIGRATION = 757;
const CHAT_EVENT_PROPERTY_COLUMNS_CONTRACT_MIGRATION = 768;
const LEGACY_CHAT_EVENT_SEQ_ID_ALLOCATOR_DROP_MIGRATION = 774;

const chatEventPropertyColumnFixture = {
  composeId: "99000000-0000-4000-8000-000000000001",
  sessionId: "99000000-0000-4000-8000-000000000002",
  historicalRunId: "99000000-0000-4000-8000-000000000003",
  previousApiRunId: "99000000-0000-4000-8000-000000000004",
  nextApiRunId: "99000000-0000-4000-8000-000000000005",
  threadId: "99000000-0000-4000-8000-000000000006",
  historicalTargetEventId: "99000000-0000-4000-8000-000000000007",
  historicalRevokerEventId: "99000000-0000-4000-8000-000000000008",
  previousApiTargetEventId: "99000000-0000-4000-8000-000000000009",
  previousApiRevokerEventId: "99000000-0000-4000-8000-000000000010",
  nextApiTargetEventId: "99000000-0000-4000-8000-000000000011",
  nextApiRevokerEventId: "99000000-0000-4000-8000-000000000012",
  postSequenceExpansionEventId: "99000000-0000-4000-8000-000000000013",
  previousApiThreadId: "99000000-0000-4000-8000-000000000014",
  nextApiThreadId: "99000000-0000-4000-8000-000000000015",
  releaseTwoPreviousApiRunId: "99000000-0000-4000-8000-000000000016",
  releaseTwoCurrentApiRunId: "99000000-0000-4000-8000-000000000017",
  releaseTwoPreviousApiTargetEventId: "99000000-0000-4000-8000-000000000018",
  releaseTwoPreviousApiRevokerEventId: "99000000-0000-4000-8000-000000000019",
  releaseTwoCurrentApiTargetEventId: "99000000-0000-4000-8000-000000000020",
  releaseTwoCurrentApiRevokerEventId: "99000000-0000-4000-8000-000000000021",
  contractRunId: "99000000-0000-4000-8000-000000000022",
  contractTargetEventId: "99000000-0000-4000-8000-000000000023",
  contractRevokerEventId: "99000000-0000-4000-8000-000000000024",
  allocatorDropTargetEventId: "99000000-0000-4000-8000-000000000025",
  allocatorDropNextEventId: "99000000-0000-4000-8000-000000000026",
  allocatorDropDuplicateEventId: "99000000-0000-4000-8000-000000000027",
  allocatorDropMissingSeqEventId: "99000000-0000-4000-8000-000000000028",
} as const;

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

async function seedChatEventPropertyColumnFixture(
  client: Client,
): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES (
        $1,
        'chat-event-property-column-user',
        'chat-event-property-column-rollout',
        'chat-event-property-column-org'
      )
    `,
    [fixture.composeId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id",
        "user_id",
        "org_id",
        "agent_compose_id"
      )
      VALUES (
        $1,
        'chat-event-property-column-user',
        'chat-event-property-column-org',
        $2
      )
    `,
    [fixture.sessionId, fixture.composeId],
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
        (
          $1,
          'chat-event-property-column-user',
          $4,
          'running',
          'historical acknowledgement',
          'chat-event-property-column-org'
        ),
        (
          $2,
          'chat-event-property-column-user',
          $4,
          'running',
          'previous API acknowledgement',
          'chat-event-property-column-org'
        ),
        (
          $3,
          'chat-event-property-column-user',
          $4,
          'running',
          'next API acknowledgement',
          'chat-event-property-column-org'
        ),
        (
          $5,
          'chat-event-property-column-user',
          $4,
          'running',
          'release 2 previous API acknowledgement',
          'chat-event-property-column-org'
        ),
        (
          $6,
          'chat-event-property-column-user',
          $4,
          'running',
          'release 2 current API acknowledgement',
          'chat-event-property-column-org'
        ),
        (
          $7,
          'chat-event-property-column-user',
          $4,
          'running',
          'release 3 canonical acknowledgement',
          'chat-event-property-column-org'
        )
    `,
    [
      fixture.historicalRunId,
      fixture.previousApiRunId,
      fixture.nextApiRunId,
      fixture.sessionId,
      fixture.releaseTwoPreviousApiRunId,
      fixture.releaseTwoCurrentApiRunId,
      fixture.contractRunId,
    ],
  );
  await client.query(
    `
      INSERT INTO "chat_threads" (
        "id",
        "user_id",
        "agent_compose_id",
        "title",
        "last_chat_message_seq_id"
      )
      VALUES (
        $1,
        'chat-event-property-column-user',
        $2,
        'chat event property column rollout',
        20
      )
    `,
    [fixture.threadId, fixture.composeId],
  );
  await client.query(
    `
      INSERT INTO "zero_runs" (
        "id",
        "trigger_source",
        "chat_thread_id",
        "api_started_at",
        "first_assistant_message_acknowledged_at"
      )
      VALUES
        ($1, 'web', $4, '2026-07-30 01:00:00', '2026-07-30 01:00:01'),
        ($2, 'web', $4, '2026-07-30 02:00:00', NULL),
        ($3, 'web', $4, '2026-07-30 03:00:00', NULL),
        ($5, 'web', $4, '2026-07-30 04:00:00', NULL),
        ($6, 'web', $4, '2026-07-30 05:00:00', NULL),
        ($7, 'web', $4, '2026-07-30 06:00:00', NULL)
    `,
    [
      fixture.historicalRunId,
      fixture.previousApiRunId,
      fixture.nextApiRunId,
      fixture.threadId,
      fixture.releaseTwoPreviousApiRunId,
      fixture.releaseTwoCurrentApiRunId,
      fixture.contractRunId,
    ],
  );
  await client.query(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content"
      )
      VALUES ($1, $2, 'output.message', 'historical target')
    `,
    [fixture.historicalTargetEventId, fixture.threadId],
  );
  await client.query(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "revokes_message_id",
        "event_type"
      )
      VALUES ($1, $2, $3, 'control.revoke')
    `,
    [
      fixture.historicalRevokerEventId,
      fixture.threadId,
      fixture.historicalTargetEventId,
    ],
  );
}

async function validateRevokesEventIdExpansion(client: Client): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  await applyMigrationsUpToInTransaction(
    client,
    REVOKES_EVENT_ID_EXPANSION_MIGRATION,
  );

  const historical = await client.query<{
    legacyRevokesEventId: string | null;
    revokesEventId: string | null;
  }>(
    `
      SELECT
        "revokes_event_id" AS "revokesEventId",
        "revokes_message_id" AS "legacyRevokesEventId"
      FROM "chat_events"
      WHERE "id" = $1
    `,
    [fixture.historicalRevokerEventId],
  );
  assert.deepEqual(historical.rows, [
    {
      legacyRevokesEventId: fixture.historicalTargetEventId,
      revokesEventId: fixture.historicalTargetEventId,
    },
  ]);

  const revokeIndexes = await client.query<{
    indexDefinition: string;
    indexName: string;
  }>(`
    SELECT
      "indexname" AS "indexName",
      "indexdef" AS "indexDefinition"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "indexname" IN (
        'chat_events_revokes_event_id_unique',
        'chat_events_revokes_message_id_unique'
      )
    ORDER BY "indexname"
  `);
  assert.deepEqual(
    revokeIndexes.rows.map((row) => {
      return row.indexName;
    }),
    [
      "chat_events_revokes_event_id_unique",
      "chat_events_revokes_message_id_unique",
    ],
  );
  assert.match(
    revokeIndexes.rows[0]?.indexDefinition ?? "",
    /\("?revokes_event_id"?\)$/,
  );
  assert.match(
    revokeIndexes.rows[1]?.indexDefinition ?? "",
    /\("?revokes_message_id"?\)$/,
  );

  await client.query(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content"
      )
      VALUES ($1, $2, 'output.message', 'previous API target')
      ON CONFLICT ("id") DO NOTHING
      RETURNING "id", "created_at", "seq_id"
    `,
    [fixture.previousApiTargetEventId, fixture.threadId],
  );
  const previousApiInsert = await client.query<{
    revokesMessageId: string | null;
  }>(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "revokes_message_id",
        "event_type"
      )
      VALUES ($1, $2, $3, 'control.revoke')
      ON CONFLICT ("revokes_message_id") DO NOTHING
      RETURNING "revokes_message_id" AS "revokesMessageId"
    `,
    [
      fixture.previousApiRevokerEventId,
      fixture.threadId,
      fixture.previousApiTargetEventId,
    ],
  );
  assert.deepEqual(previousApiInsert.rows, [
    { revokesMessageId: fixture.previousApiTargetEventId },
  ]);

  await client.query(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content"
      )
      VALUES ($1, $2, 'output.message', 'next API target')
      ON CONFLICT ("id") DO NOTHING
      RETURNING "id", "created_at", "seq_id"
    `,
    [fixture.nextApiTargetEventId, fixture.threadId],
  );
  const nextApiInsert = await client.query<{
    revokesEventId: string | null;
  }>(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "revokes_event_id",
        "event_type"
      )
      VALUES ($1, $2, $3, 'control.revoke')
      ON CONFLICT ("revokes_event_id") DO NOTHING
      RETURNING "revokes_event_id" AS "revokesEventId"
    `,
    [
      fixture.nextApiRevokerEventId,
      fixture.threadId,
      fixture.nextApiTargetEventId,
    ],
  );
  assert.deepEqual(nextApiInsert.rows, [
    { revokesEventId: fixture.nextApiTargetEventId },
  ]);

  const crossVersionRows = await client.query<{
    legacyRevokesEventId: string;
    revokesEventId: string;
  }>(`
    SELECT
      "revokes_event_id" AS "revokesEventId",
      "revokes_message_id" AS "legacyRevokesEventId"
    FROM "chat_events"
    WHERE "id" IN (
      '${fixture.previousApiRevokerEventId}',
      '${fixture.nextApiRevokerEventId}'
    )
    ORDER BY "id"
  `);
  assert.deepEqual(crossVersionRows.rows, [
    {
      legacyRevokesEventId: fixture.previousApiTargetEventId,
      revokesEventId: fixture.previousApiTargetEventId,
    },
    {
      legacyRevokesEventId: fixture.nextApiTargetEventId,
      revokesEventId: fixture.nextApiTargetEventId,
    },
  ]);
  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.historicalRevokerEventId,
  );
}

async function validateLastChatEventSeqIdExpansion(
  client: Client,
): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  await applyMigrationsUpToInTransaction(
    client,
    LAST_CHAT_EVENT_SEQ_ID_EXPANSION_MIGRATION,
  );

  const historical = await client.query<{
    lastChatEventSeqId: string;
    lastChatMessageSeqId: string;
  }>(
    `
      SELECT
        "last_chat_event_seq_id" AS "lastChatEventSeqId",
        "last_chat_message_seq_id" AS "lastChatMessageSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [fixture.threadId],
  );
  assert.deepEqual(historical.rows, [
    { lastChatEventSeqId: "26", lastChatMessageSeqId: "26" },
  ]);

  const previousApiUpdate = await client.query<{ lastSeqId: string }>(
    `
      UPDATE "chat_threads"
      SET "last_chat_message_seq_id" = "last_chat_message_seq_id" + 1
      WHERE "id" = $1
      RETURNING "last_chat_message_seq_id" AS "lastSeqId"
    `,
    [fixture.threadId],
  );
  assert.deepEqual(previousApiUpdate.rows, [{ lastSeqId: "27" }]);

  const nextApiUpdate = await client.query<{ lastSeqId: string }>(
    `
      UPDATE "chat_threads"
      SET "last_chat_event_seq_id" = "last_chat_event_seq_id" + 1
      WHERE "id" = $1
      RETURNING "last_chat_event_seq_id" AS "lastSeqId"
    `,
    [fixture.threadId],
  );
  assert.deepEqual(nextApiUpdate.rows, [{ lastSeqId: "28" }]);

  const previousApiInsert = await client.query<{ lastSeqId: string }>(
    `
      INSERT INTO "chat_threads" (
        "id",
        "user_id",
        "agent_compose_id",
        "title",
        "last_chat_message_seq_id"
      )
      VALUES (
        $1,
        'chat-event-property-column-user',
        $2,
        'previous API thread',
        7
      )
      RETURNING "last_chat_message_seq_id" AS "lastSeqId"
    `,
    [fixture.previousApiThreadId, fixture.composeId],
  );
  assert.deepEqual(previousApiInsert.rows, [{ lastSeqId: "7" }]);

  const nextApiInsert = await client.query<{ lastSeqId: string }>(
    `
      INSERT INTO "chat_threads" (
        "id",
        "user_id",
        "agent_compose_id",
        "title",
        "last_chat_event_seq_id"
      )
      VALUES (
        $1,
        'chat-event-property-column-user',
        $2,
        'next API thread',
        9
      )
      RETURNING "last_chat_event_seq_id" AS "lastSeqId"
    `,
    [fixture.nextApiThreadId, fixture.composeId],
  );
  assert.deepEqual(nextApiInsert.rows, [{ lastSeqId: "9" }]);

  const insertedEvent = await client.query<{ seqId: string }>(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content"
      )
      VALUES ($1, $2, 'output.message', 'persisted allocator after expansion')
      RETURNING "seq_id" AS "seqId"
    `,
    [fixture.postSequenceExpansionEventId, fixture.threadId],
  );
  assert.deepEqual(insertedEvent.rows, [{ seqId: "29" }]);

  const mirroredThreads = await client.query<{
    id: string;
    lastChatEventSeqId: string;
    lastChatMessageSeqId: string;
  }>(`
    SELECT
      "id",
      "last_chat_event_seq_id" AS "lastChatEventSeqId",
      "last_chat_message_seq_id" AS "lastChatMessageSeqId"
    FROM "chat_threads"
    WHERE "id" IN (
      '${fixture.threadId}',
      '${fixture.previousApiThreadId}',
      '${fixture.nextApiThreadId}'
    )
    ORDER BY "id"
  `);
  assert.deepEqual(mirroredThreads.rows, [
    {
      id: fixture.threadId,
      lastChatEventSeqId: "29",
      lastChatMessageSeqId: "29",
    },
    {
      id: fixture.previousApiThreadId,
      lastChatEventSeqId: "7",
      lastChatMessageSeqId: "7",
    },
    {
      id: fixture.nextApiThreadId,
      lastChatEventSeqId: "9",
      lastChatMessageSeqId: "9",
    },
  ]);
  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.historicalRevokerEventId,
  );
}

async function validateFirstAssistantEventAckExpansion(
  client: Client,
): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  await applyMigrationsUpToInTransaction(
    client,
    FIRST_ASSISTANT_EVENT_ACK_EXPANSION_MIGRATION,
  );

  const historical = await client.query<{
    canonicalAcknowledgedAt: string | null;
    legacyAcknowledgedAt: string | null;
  }>(
    `
      SELECT
        to_char(
          "first_assistant_event_acknowledged_at",
          'YYYY-MM-DD HH24:MI:SS'
        ) AS "canonicalAcknowledgedAt",
        to_char(
          "first_assistant_message_acknowledged_at",
          'YYYY-MM-DD HH24:MI:SS'
        ) AS "legacyAcknowledgedAt"
      FROM "zero_runs"
      WHERE "id" = $1
    `,
    [fixture.historicalRunId],
  );
  assert.deepEqual(historical.rows, [
    {
      canonicalAcknowledgedAt: "2026-07-30 01:00:01",
      legacyAcknowledgedAt: "2026-07-30 01:00:01",
    },
  ]);

  const previousApiUpdate = await client.query<{ apiStartedAt: Date }>(
    `
      UPDATE "zero_runs"
      SET "first_assistant_message_acknowledged_at" =
        '2026-07-30 02:00:01'
      WHERE "id" = $1
        AND "api_started_at" IS NOT NULL
        AND "first_assistant_message_acknowledged_at" IS NULL
      RETURNING "api_started_at" AS "apiStartedAt"
    `,
    [fixture.previousApiRunId],
  );
  assert.equal(previousApiUpdate.rows.length, 1);

  const nextApiUpdate = await client.query<{ apiStartedAt: Date }>(
    `
      UPDATE "zero_runs"
      SET "first_assistant_event_acknowledged_at" =
        '2026-07-30 03:00:01'
      WHERE "id" = $1
        AND "api_started_at" IS NOT NULL
        AND "first_assistant_event_acknowledged_at" IS NULL
      RETURNING "api_started_at" AS "apiStartedAt"
    `,
    [fixture.nextApiRunId],
  );
  assert.equal(nextApiUpdate.rows.length, 1);

  const mirroredRuns = await client.query<{
    canonicalAcknowledgedAt: string | null;
    id: string;
    legacyAcknowledgedAt: string | null;
  }>(`
    SELECT
      "id",
      to_char(
        "first_assistant_event_acknowledged_at",
        'YYYY-MM-DD HH24:MI:SS'
      ) AS "canonicalAcknowledgedAt",
      to_char(
        "first_assistant_message_acknowledged_at",
        'YYYY-MM-DD HH24:MI:SS'
      ) AS "legacyAcknowledgedAt"
    FROM "zero_runs"
    WHERE "id" IN (
      '${fixture.previousApiRunId}',
      '${fixture.nextApiRunId}'
    )
    ORDER BY "id"
  `);
  assert.deepEqual(mirroredRuns.rows, [
    {
      canonicalAcknowledgedAt: "2026-07-30 02:00:01",
      id: fixture.previousApiRunId,
      legacyAcknowledgedAt: "2026-07-30 02:00:01",
    },
    {
      canonicalAcknowledgedAt: "2026-07-30 03:00:01",
      id: fixture.nextApiRunId,
      legacyAcknowledgedAt: "2026-07-30 03:00:01",
    },
  ]);
  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.historicalRevokerEventId,
  );
}

async function validateChatEventPropertyColumnRuntimeCutover(
  client: Client,
): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  const database = drizzle(client);

  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.historicalRevokerEventId,
  );

  const previousReservation = await client.query<{ lastSeqId: string }>(
    `
      UPDATE "chat_threads"
      SET "last_chat_message_seq_id" = "last_chat_message_seq_id" + 2
      WHERE "id" = $1
      RETURNING "last_chat_message_seq_id" AS "lastSeqId"
    `,
    [fixture.threadId],
  );
  const previousLastSeqId = Number(previousReservation.rows[0]?.lastSeqId);
  assert.ok(Number.isSafeInteger(previousLastSeqId));
  const previousApiInsert = await client.query<{
    id: string;
    revokesMessageId: string | null;
  }>(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "revokes_message_id",
        "event_type",
        "content",
        "seq_id"
      )
      VALUES
        ($1, $3, NULL, 'output.message', 'release 2 previous API target', $4),
        ($2, $3, $1, 'control.revoke', NULL, $5)
      ON CONFLICT ("revokes_message_id") DO NOTHING
      RETURNING
        "id",
        "revokes_message_id" AS "revokesMessageId"
    `,
    [
      fixture.releaseTwoPreviousApiTargetEventId,
      fixture.releaseTwoPreviousApiRevokerEventId,
      fixture.threadId,
      previousLastSeqId - 1,
      previousLastSeqId,
    ],
  );
  assert.deepEqual(previousApiInsert.rows, [
    {
      id: fixture.releaseTwoPreviousApiTargetEventId,
      revokesMessageId: null,
    },
    {
      id: fixture.releaseTwoPreviousApiRevokerEventId,
      revokesMessageId: fixture.releaseTwoPreviousApiTargetEventId,
    },
  ]);
  const previousApiAcknowledgement = await client.query<{ id: string }>(
    `
      UPDATE "zero_runs"
      SET "first_assistant_message_acknowledged_at" =
        '2026-07-30 04:00:01'
      WHERE "id" = $1
        AND "first_assistant_message_acknowledged_at" IS NULL
      RETURNING "id"
    `,
    [fixture.releaseTwoPreviousApiRunId],
  );
  assert.deepEqual(previousApiAcknowledgement.rows, [
    { id: fixture.releaseTwoPreviousApiRunId },
  ]);

  const [currentReservation] = await database
    .update(chatThreads)
    .set({
      lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + 2`,
    })
    .where(eq(chatThreads.id, fixture.threadId))
    .returning({ lastSeqId: chatThreads.lastChatEventSeqId });
  assert.ok(currentReservation);
  const currentApiInsert = await database
    .insert(chatEvents)
    .values([
      {
        id: fixture.releaseTwoCurrentApiTargetEventId,
        chatThreadId: fixture.threadId,
        eventType: "output.message",
        content: "release 2 current API target",
        seqId: currentReservation.lastSeqId - 1,
      },
      {
        id: fixture.releaseTwoCurrentApiRevokerEventId,
        chatThreadId: fixture.threadId,
        revokesEventId: fixture.releaseTwoCurrentApiTargetEventId,
        eventType: "control.revoke",
        seqId: currentReservation.lastSeqId,
      },
    ])
    .onConflictDoNothing({ target: chatEvents.revokesEventId })
    .returning({
      id: chatEvents.id,
      revokesEventId: chatEvents.revokesEventId,
    });
  assert.deepEqual(currentApiInsert, [
    {
      id: fixture.releaseTwoCurrentApiTargetEventId,
      revokesEventId: null,
    },
    {
      id: fixture.releaseTwoCurrentApiRevokerEventId,
      revokesEventId: fixture.releaseTwoCurrentApiTargetEventId,
    },
  ]);
  const currentApiAcknowledgement = await database
    .update(zeroRuns)
    .set({
      firstAssistantEventAcknowledgedAt: new Date("2026-07-30T05:00:01.000Z"),
    })
    .where(eq(zeroRuns.id, fixture.releaseTwoCurrentApiRunId))
    .returning({ id: zeroRuns.id });
  assert.deepEqual(currentApiAcknowledgement, [
    { id: fixture.releaseTwoCurrentApiRunId },
  ]);

  assert.deepEqual(
    await database
      .select({
        id: chatEvents.id,
        revokesEventId: chatEvents.revokesEventId,
      })
      .from(chatEvents)
      .where(eq(chatEvents.id, fixture.releaseTwoPreviousApiRevokerEventId)),
    [
      {
        id: fixture.releaseTwoPreviousApiRevokerEventId,
        revokesEventId: fixture.releaseTwoPreviousApiTargetEventId,
      },
    ],
  );
  assert.deepEqual(
    await database
      .select({
        id: chatEvents.id,
        revokesEventId: chatEvents.revokesEventId,
      })
      .from(chatEvents)
      .where(eq(chatEvents.id, fixture.releaseTwoCurrentApiRevokerEventId)),
    [
      {
        id: fixture.releaseTwoCurrentApiRevokerEventId,
        revokesEventId: fixture.releaseTwoCurrentApiTargetEventId,
      },
    ],
  );

  const mirroredRevokers = await client.query<{
    id: string;
    legacyRevokesEventId: string;
    revokesEventId: string;
  }>(
    `
      SELECT
        "id",
        "revokes_event_id" AS "revokesEventId",
        "revokes_message_id" AS "legacyRevokesEventId"
      FROM "chat_events"
      WHERE "id" IN ($1, $2)
      ORDER BY "id"
    `,
    [
      fixture.releaseTwoPreviousApiRevokerEventId,
      fixture.releaseTwoCurrentApiRevokerEventId,
    ],
  );
  assert.deepEqual(mirroredRevokers.rows, [
    {
      id: fixture.releaseTwoPreviousApiRevokerEventId,
      legacyRevokesEventId: fixture.releaseTwoPreviousApiTargetEventId,
      revokesEventId: fixture.releaseTwoPreviousApiTargetEventId,
    },
    {
      id: fixture.releaseTwoCurrentApiRevokerEventId,
      legacyRevokesEventId: fixture.releaseTwoCurrentApiTargetEventId,
      revokesEventId: fixture.releaseTwoCurrentApiTargetEventId,
    },
  ]);

  const mirroredSequence = await client.query<{
    lastChatEventSeqId: string;
    lastChatMessageSeqId: string;
  }>(
    `
      SELECT
        "last_chat_event_seq_id" AS "lastChatEventSeqId",
        "last_chat_message_seq_id" AS "lastChatMessageSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [fixture.threadId],
  );
  assert.deepEqual(mirroredSequence.rows, [
    {
      lastChatEventSeqId: String(currentReservation.lastSeqId),
      lastChatMessageSeqId: String(currentReservation.lastSeqId),
    },
  ]);

  const mirroredAcknowledgements = await client.query<{
    canonicalAcknowledgedAt: string | null;
    id: string;
    legacyAcknowledgedAt: string | null;
  }>(
    `
      SELECT
        "id",
        to_char(
          "first_assistant_event_acknowledged_at",
          'YYYY-MM-DD HH24:MI:SS'
        ) AS "canonicalAcknowledgedAt",
        to_char(
          "first_assistant_message_acknowledged_at",
          'YYYY-MM-DD HH24:MI:SS'
        ) AS "legacyAcknowledgedAt"
      FROM "zero_runs"
      WHERE "id" IN ($1, $2)
      ORDER BY "id"
    `,
    [fixture.releaseTwoPreviousApiRunId, fixture.releaseTwoCurrentApiRunId],
  );
  assert.equal(mirroredAcknowledgements.rows.length, 2);
  for (const acknowledgement of mirroredAcknowledgements.rows) {
    assert.notEqual(acknowledgement.canonicalAcknowledgedAt, null);
    assert.equal(
      acknowledgement.canonicalAcknowledgedAt,
      acknowledgement.legacyAcknowledgedAt,
    );
  }

  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.releaseTwoCurrentApiRevokerEventId,
  );
}

async function validateChatEventPropertyColumnContraction(
  client: Client,
): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  await applyMigrationsUpToInTransaction(
    client,
    CHAT_EVENT_PROPERTY_COLUMNS_CONTRACT_MIGRATION,
  );
  const database = drizzle(client);

  assert.deepEqual(
    await database
      .select({
        id: chatEvents.id,
        revokesEventId: chatEvents.revokesEventId,
      })
      .from(chatEvents)
      .where(eq(chatEvents.id, fixture.historicalRevokerEventId)),
    [
      {
        id: fixture.historicalRevokerEventId,
        revokesEventId: fixture.historicalTargetEventId,
      },
    ],
  );
  const historicalAcknowledgement = await client.query<{
    acknowledgedAt: string;
    id: string;
  }>(
    `
      SELECT
        "id",
        to_char(
          "first_assistant_event_acknowledged_at",
          'YYYY-MM-DD HH24:MI:SS'
        ) AS "acknowledgedAt"
      FROM "zero_runs"
      WHERE "id" = $1
    `,
    [fixture.historicalRunId],
  );
  assert.deepEqual(historicalAcknowledgement.rows, [
    {
      acknowledgedAt: "2026-07-30 01:00:01",
      id: fixture.historicalRunId,
    },
  ]);

  const sequenceBefore = await client.query<{ lastSeqId: string }>(
    `
      SELECT "last_chat_event_seq_id" AS "lastSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [fixture.threadId],
  );
  const previousLastSeqId = Number(sequenceBefore.rows[0]?.lastSeqId);
  assert.ok(Number.isSafeInteger(previousLastSeqId));

  const targetInsert = await client.query<{ id: string; seqId: string }>(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content"
      )
      VALUES ($1, $2, 'output.message', 'release 3 canonical target')
      RETURNING "id", "seq_id" AS "seqId"
    `,
    [fixture.contractTargetEventId, fixture.threadId],
  );
  assert.deepEqual(targetInsert.rows, [
    {
      id: fixture.contractTargetEventId,
      seqId: String(previousLastSeqId + 1),
    },
  ]);

  const revokerInsert = await client.query<{
    id: string;
    revokesEventId: string;
    seqId: string;
  }>(
    `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "revokes_event_id",
        "event_type"
      )
      VALUES ($1, $2, $3, 'control.revoke')
      ON CONFLICT ("revokes_event_id") DO NOTHING
      RETURNING
        "id",
        "revokes_event_id" AS "revokesEventId",
        "seq_id" AS "seqId"
    `,
    [
      fixture.contractRevokerEventId,
      fixture.threadId,
      fixture.contractTargetEventId,
    ],
  );
  assert.deepEqual(revokerInsert.rows, [
    {
      id: fixture.contractRevokerEventId,
      revokesEventId: fixture.contractTargetEventId,
      seqId: String(previousLastSeqId + 2),
    },
  ]);

  const revokeChain = await client.query<{
    revokerId: string;
    targetId: string;
  }>(
    `
      SELECT
        "revoker"."id" AS "revokerId",
        "target"."id" AS "targetId"
      FROM "chat_events" AS "revoker"
      INNER JOIN "chat_events" AS "target"
        ON "target"."id" = "revoker"."revokes_event_id"
      WHERE "revoker"."id" = $1
    `,
    [fixture.contractRevokerEventId],
  );
  assert.deepEqual(revokeChain.rows, [
    {
      revokerId: fixture.contractRevokerEventId,
      targetId: fixture.contractTargetEventId,
    },
  ]);

  assert.deepEqual(
    await database
      .update(zeroRuns)
      .set({
        firstAssistantEventAcknowledgedAt: new Date("2026-07-30T06:00:01.000Z"),
      })
      .where(eq(zeroRuns.id, fixture.contractRunId))
      .returning({
        id: zeroRuns.id,
      }),
    [
      {
        id: fixture.contractRunId,
      },
    ],
  );
  const contractAcknowledgement = await client.query<{
    acknowledgedAt: string;
  }>(
    `
      SELECT to_char(
        "first_assistant_event_acknowledged_at",
        'YYYY-MM-DD HH24:MI:SS'
      ) AS "acknowledgedAt"
      FROM "zero_runs"
      WHERE "id" = $1
    `,
    [fixture.contractRunId],
  );
  assert.deepEqual(contractAcknowledgement.rows, [
    { acknowledgedAt: "2026-07-30 06:00:01" },
  ]);

  const canonicalSequence = await client.query<{ lastSeqId: string }>(
    `
      SELECT "last_chat_event_seq_id" AS "lastSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [fixture.threadId],
  );
  assert.deepEqual(canonicalSequence.rows, [
    { lastSeqId: String(previousLastSeqId + 2) },
  ]);

  const legacyColumns = await client.query<{
    columnName: string;
    tableName: string;
  }>(`
    SELECT
      "table_name" AS "tableName",
      "column_name" AS "columnName"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND (
        ("table_name" = 'chat_events' AND "column_name" = 'revokes_message_id')
        OR (
          "table_name" = 'chat_threads'
          AND "column_name" = 'last_chat_message_seq_id'
        )
        OR (
          "table_name" = 'zero_runs'
          AND "column_name" = 'first_assistant_message_acknowledged_at'
        )
      )
  `);
  assert.deepEqual(legacyColumns.rows, []);

  const legacyCompatibilityObjects = await client.query<{
    objectName: string;
    objectType: string;
  }>(`
    SELECT
      'trigger' AS "objectType",
      "tgname" AS "objectName"
    FROM "pg_trigger"
    WHERE NOT "tgisinternal"
      AND "tgname" IN (
        'bridge_chat_event_revokes_event_id_0755',
        'bridge_chat_thread_last_chat_event_seq_id_0756',
        'bridge_zero_run_first_assistant_event_ack_0757'
      )
    UNION ALL
    SELECT
      'function',
      "proname"
    FROM "pg_proc"
    WHERE "proname" IN (
      'bridge_chat_event_revokes_event_id_0755',
      'bridge_chat_thread_last_chat_event_seq_id_0756',
      'bridge_zero_run_first_assistant_event_ack_0757'
    )
    UNION ALL
    SELECT
      'index',
      "indexname"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "indexname" = 'chat_events_revokes_message_id_unique'
    UNION ALL
    SELECT
      'constraint',
      "conname"
    FROM "pg_constraint"
    WHERE "conname" =
      'chat_events_revokes_message_id_chat_events_id_fk'
  `);
  assert.deepEqual(legacyCompatibilityObjects.rows, []);

  const persistedFunctions = await client.query<{
    allocatorBody: string;
    appendOnlyBody: string;
  }>(`
    SELECT
      (
        SELECT "prosrc"
        FROM "pg_proc"
        WHERE "proname" = 'allocate_legacy_chat_message_seq_id'
      ) AS "allocatorBody",
      (
        SELECT "prosrc"
        FROM "pg_proc"
        WHERE "proname" = 'reject_chat_event_source_update'
      ) AS "appendOnlyBody"
  `);
  assert.equal(persistedFunctions.rows.length, 1);
  const persistedFunctionBodies = persistedFunctions.rows[0];
  assert.ok(persistedFunctionBodies);
  assert.match(persistedFunctionBodies.allocatorBody, /last_chat_event_seq_id/);
  assert.doesNotMatch(
    persistedFunctionBodies.allocatorBody,
    /last_chat_message_seq_id/,
  );
  assert.match(persistedFunctionBodies.appendOnlyBody, /RAISE EXCEPTION/);
  assert.doesNotMatch(
    persistedFunctionBodies.appendOnlyBody,
    /\bIF\b|\bRETURN\b/i,
  );

  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.contractRevokerEventId,
  );
}

async function validateLegacyChatEventSeqIdAllocatorDrop(
  client: Client,
): Promise<void> {
  const fixture = chatEventPropertyColumnFixture;
  await applyMigrationsUpToInTransaction(
    client,
    LEGACY_CHAT_EVENT_SEQ_ID_ALLOCATOR_DROP_MIGRATION,
  );
  const database = drizzle(client);

  const legacyAllocatorObjects = await client.query<{
    objectName: string;
    objectType: string;
  }>(`
    SELECT
      'trigger' AS "objectType",
      "tgname" AS "objectName"
    FROM "pg_trigger"
    WHERE NOT "tgisinternal"
      AND "tgname" = 'allocate_legacy_chat_message_seq_id'
    UNION ALL
    SELECT
      'function',
      "proname"
    FROM "pg_proc"
    WHERE "pronamespace" = 'public'::regnamespace
      AND "proname" = 'allocate_legacy_chat_message_seq_id'
  `);
  assert.deepEqual(legacyAllocatorObjects.rows, []);

  const sequenceIndex = await client.query<{
    indexDefinition: string;
    indexName: string;
  }>(`
    SELECT
      "indexname" AS "indexName",
      "indexdef" AS "indexDefinition"
    FROM "pg_indexes"
    WHERE "schemaname" = 'public'
      AND "tablename" = 'chat_events'
      AND "indexname" = 'chat_events_thread_seq_unique'
  `);
  assert.equal(sequenceIndex.rows.length, 1);
  assert.match(
    sequenceIndex.rows[0]?.indexDefinition ?? "",
    /^CREATE UNIQUE INDEX .* \(chat_thread_id, seq_id\)$/u,
  );

  const sequenceBefore = await client.query<{
    lastSeqId: string;
    maxSeqId: string;
  }>(
    `
      SELECT
        "thread"."last_chat_event_seq_id" AS "lastSeqId",
        max("event"."seq_id")::text AS "maxSeqId"
      FROM "chat_threads" AS "thread"
      INNER JOIN "chat_events" AS "event"
        ON "event"."chat_thread_id" = "thread"."id"
      WHERE "thread"."id" = $1
      GROUP BY "thread"."last_chat_event_seq_id"
    `,
    [fixture.threadId],
  );
  assert.equal(sequenceBefore.rows.length, 1);
  const previousLastSeqId = Number(sequenceBefore.rows[0]?.lastSeqId);
  assert.ok(Number.isSafeInteger(previousLastSeqId));
  assert.equal(sequenceBefore.rows[0]?.maxSeqId, String(previousLastSeqId));

  const [reservation] = await database
    .update(chatThreads)
    .set({
      lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + 2`,
    })
    .where(eq(chatThreads.id, fixture.threadId))
    .returning({ lastSeqId: chatThreads.lastChatEventSeqId });
  assert.ok(reservation);
  assert.equal(reservation.lastSeqId, previousLastSeqId + 2);
  const firstSeqId = reservation.lastSeqId - 1;
  const canonicalInserts = await database
    .insert(chatEvents)
    .values([
      {
        id: fixture.allocatorDropTargetEventId,
        chatThreadId: fixture.threadId,
        eventType: "output.message",
        content: "canonical target after allocator drop",
        seqId: firstSeqId,
      },
      {
        id: fixture.allocatorDropNextEventId,
        chatThreadId: fixture.threadId,
        eventType: "output.message",
        content: "canonical next event after allocator drop",
        seqId: reservation.lastSeqId,
      },
    ])
    .returning({
      id: chatEvents.id,
      seqId: chatEvents.seqId,
    });
  assert.deepEqual(canonicalInserts, [
    {
      id: fixture.allocatorDropTargetEventId,
      seqId: firstSeqId,
    },
    {
      id: fixture.allocatorDropNextEventId,
      seqId: reservation.lastSeqId,
    },
  ]);

  const sequenceState = await client.query<{
    lastSeqId: string;
    maxSeqId: string;
  }>(
    `
      SELECT
        "thread"."last_chat_event_seq_id" AS "lastSeqId",
        max("event"."seq_id")::text AS "maxSeqId"
      FROM "chat_threads" AS "thread"
      INNER JOIN "chat_events" AS "event"
        ON "event"."chat_thread_id" = "thread"."id"
      WHERE "thread"."id" = $1
      GROUP BY "thread"."last_chat_event_seq_id"
    `,
    [fixture.threadId],
  );
  assert.deepEqual(sequenceState.rows, [
    {
      lastSeqId: String(reservation.lastSeqId),
      maxSeqId: String(reservation.lastSeqId),
    },
  ]);

  await expectDatabaseError(client, {
    code: "23505",
    messageIncludes: "chat_events_thread_seq_unique",
    query: `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content",
        "seq_id"
      )
      VALUES ($1, $2, 'output.message', 'duplicate seq_id', $3)
    `,
    values: [
      fixture.allocatorDropDuplicateEventId,
      fixture.threadId,
      reservation.lastSeqId,
    ],
  });
  await expectDatabaseError(client, {
    code: "23502",
    messageIncludes: "seq_id",
    query: `
      INSERT INTO "chat_events" (
        "id",
        "chat_thread_id",
        "event_type",
        "content"
      )
      VALUES ($1, $2, 'output.message', 'missing seq_id')
    `,
    values: [fixture.allocatorDropMissingSeqEventId, fixture.threadId],
  });

  await assertChatEventsAppendOnlyProtection(
    client,
    fixture.allocatorDropNextEventId,
  );
}

async function validateChatEventPropertyColumnRollout(): Promise<void> {
  console.log(
    "=== Validate populated ChatEvent property column runtime cutover ===\n",
  );
  const testDb = "migration_chat_event_property_columns_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CHAT_EVENT_PROPERTY_COLUMNS_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await seedChatEventPropertyColumnFixture(client);
      await assertChatEventsAppendOnlyProtection(
        client,
        chatEventPropertyColumnFixture.historicalRevokerEventId,
      );
      await validateRevokesEventIdExpansion(client);
      await validateLastChatEventSeqIdExpansion(client);
      await validateFirstAssistantEventAckExpansion(client);
      await validateChatEventPropertyColumnRuntimeCutover(client);
      await validateChatEventPropertyColumnContraction(client);
      await validateLegacyChatEventSeqIdAllocatorDrop(client);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ The expanded legacy/current window remains compatible, historical values survive contraction, canonical sequence/revoke/acknowledgement paths stay healthy, legacy compatibility objects are gone, missing seq_ids fail loudly, and strict append-only protection remains enabled\n",
  );
}

const SESSION_STORAGE_BACKFILL_PREVIOUS_MIGRATION = 653;
const SESSION_STORAGE_BACKFILL_MIGRATION = 654;

const sessionStorageBackfillFixture = {
  orgId: "session-storage-backfill-org",
  userId: "session-storage-backfill-user",
  composeId: "70000000-0000-4000-8000-000000000001",
  legacySessionId: "70000000-0000-4000-8000-000000000002",
  emptySessionId: "70000000-0000-4000-8000-000000000003",
  canonicalSessionId: "70000000-0000-4000-8000-000000000004",
  provenanceSessionId: "70000000-0000-4000-8000-000000000005",
  missingLatestSessionId: "70000000-0000-4000-8000-000000000006",
  missingImplicitLatestSessionId: "70000000-0000-4000-8000-000000000007",
  storageIds: {
    head: "71000000-0000-4000-8000-000000000001",
    latest: "71000000-0000-4000-8000-000000000002",
    pinned: "71000000-0000-4000-8000-000000000003",
    prefix: "71000000-0000-4000-8000-000000000004",
  },
  versionIds: {
    head: "a".repeat(64),
    latest: "b".repeat(64),
    pinned: "c".repeat(64),
    prefix: "d".repeat(64),
  },
} as const;

async function seedSessionStorageBackfillFixture(
  client: Client,
): Promise<void> {
  const fixture = sessionStorageBackfillFixture;
  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, $2, 'session-storage-backfill', $3)
    `,
    [fixture.composeId, fixture.userId, fixture.orgId],
  );

  for (const name of ["head", "latest", "pinned", "prefix"] as const) {
    const storageId = fixture.storageIds[name];
    const versionId = fixture.versionIds[name];
    await client.query(
      `
        INSERT INTO "storages"
          ("id", "user_id", "name", "type", "org_id", "s3_prefix")
        VALUES ($1, $2, $3, 'artifact', $4, $5)
      `,
      [
        storageId,
        fixture.userId,
        name,
        fixture.orgId,
        `session-storage-backfill/${name}`,
      ],
    );
    await client.query(
      `
        INSERT INTO "storage_versions"
          ("id", "storage_id", "s3_key", "archive_size", "created_by")
        VALUES ($1, $2, $3, 0, 'migration-test')
      `,
      [versionId, storageId, `session-storage-backfill/${name}/${versionId}`],
    );
    await client.query(
      `
        UPDATE "storages"
        SET "head_version_id" = $1
        WHERE "id" = $2
      `,
      [versionId, storageId],
    );
  }

  const legacyArtifacts = [
    { name: "head", mountPath: "/home/oai/share/head" },
    {
      name: "latest",
      version: "latest",
      mountPath: "/home/oai/share/latest",
      missingRootPolicy: "preserveParentVersion",
    },
    {
      name: "pinned",
      version: fixture.versionIds.pinned,
      mountPath: "/home/oai/share/pinned",
    },
    {
      name: "prefix",
      version: fixture.versionIds.prefix.slice(0, 8),
      mountPath: "/home/oai/share/prefix",
    },
  ];
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id",
        "user_id",
        "org_id",
        "agent_compose_id",
        "artifacts",
        "updated_at"
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, '2020-01-01 00:00:00')
    `,
    [
      fixture.legacySessionId,
      fixture.userId,
      fixture.orgId,
      fixture.composeId,
      JSON.stringify(legacyArtifacts),
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id",
        "user_id",
        "org_id",
        "agent_compose_id",
        "artifacts",
        "updated_at"
      )
      VALUES ($1, $2, $3, $4, '[]'::jsonb, '2020-01-02 00:00:00')
    `,
    [fixture.emptySessionId, fixture.userId, fixture.orgId, fixture.composeId],
  );

  const canonicalMounts = [
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "head",
      storageId: fixture.storageIds.head,
      mountPath: "/home/oai/share/head",
      writeback: true,
    },
  ];
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id",
        "user_id",
        "org_id",
        "agent_compose_id",
        "artifacts",
        "storage_mounts",
        "updated_at"
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        '[]'::jsonb,
        $5::jsonb,
        '2020-01-03 00:00:00'
      )
    `,
    [
      fixture.canonicalSessionId,
      fixture.userId,
      fixture.orgId,
      fixture.composeId,
      JSON.stringify(canonicalMounts),
    ],
  );

  const historicalSessions = [
    {
      id: fixture.provenanceSessionId,
      artifacts: [
        {
          name: "head",
          mountPath: "/home/oai/share/provenance",
          generatedBy: "apiAutoMemory",
        },
      ],
      updatedAt: "2020-01-04 00:00:00",
    },
    {
      id: fixture.missingLatestSessionId,
      artifacts: [
        {
          name: "recreated",
          version: "latest",
          mountPath: "/home/oai/share/recreated-latest",
          generatedBy: "apiAutoMemory",
        },
      ],
      updatedAt: "2020-01-05 00:00:00",
    },
    {
      id: fixture.missingImplicitLatestSessionId,
      artifacts: [
        {
          name: "recreated",
          mountPath: "/home/oai/share/recreated-implicit",
        },
      ],
      updatedAt: "2020-01-06 00:00:00",
    },
  ] as const;

  for (const session of historicalSessions) {
    await client.query(
      `
        INSERT INTO "agent_sessions" (
          "id",
          "user_id",
          "org_id",
          "agent_compose_id",
          "artifacts",
          "updated_at"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [
        session.id,
        fixture.userId,
        fixture.orgId,
        fixture.composeId,
        JSON.stringify(session.artifacts),
        session.updatedAt,
      ],
    );
  }
}

async function seedSessionStorageBackfillRejections(
  client: Client,
): Promise<void> {
  const fixture = sessionStorageBackfillFixture;
  const rows = [
    {
      id: "72000000-0000-4000-8000-000000000001",
      artifacts: [
        {
          name: "head",
          mountPath: "/home/oai/share/malformed",
          unexpected: true,
        },
        {
          name: "latest",
          mountPath: "/home/oai/share/malformed-generated-by",
          generatedBy: "unknown",
        },
      ],
      storageMounts: null,
    },
    {
      id: "72000000-0000-4000-8000-000000000002",
      artifacts: [
        { name: "head", mountPath: "/home/oai/share/duplicate-one" },
        { name: "head", mountPath: "/home/oai/share/duplicate-two" },
      ],
      storageMounts: null,
    },
    {
      id: "72000000-0000-4000-8000-000000000003",
      artifacts: [
        {
          name: "missing",
          version: "deadbeef",
          mountPath: "/home/oai/share/missing",
        },
      ],
      storageMounts: null,
    },
    {
      id: "72000000-0000-4000-8000-000000000004",
      artifacts: [
        {
          name: "pinned",
          version: "deadbeef",
          mountPath: "/home/oai/share/unresolved",
        },
      ],
      storageMounts: null,
    },
    {
      id: "72000000-0000-4000-8000-000000000005",
      artifacts: [
        { name: "head", mountPath: "/home/oai/share/conflict-source" },
      ],
      storageMounts: [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: fixture.storageIds.head,
          mountPath: "/home/oai/share/conflict-target",
          writeback: true,
        },
      ],
    },
    {
      id: "72000000-0000-4000-8000-000000000006",
      artifacts: [],
      storageMounts: { malformed: true },
    },
    {
      id: "72000000-0000-4000-8000-000000000007",
      artifacts: [],
      storageMounts: [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: fixture.storageIds.head,
          mountPath: "/home/oai/share/canonical-duplicate-one",
          writeback: true,
        },
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: fixture.storageIds.head,
          mountPath: "/home/oai/share/canonical-duplicate-two",
          writeback: true,
        },
      ],
    },
    {
      id: "72000000-0000-4000-8000-000000000008",
      artifacts: [],
      storageMounts: [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: "71000000-0000-4000-8000-000000000099",
          mountPath: "/home/oai/share/stale-identity",
          writeback: true,
        },
      ],
    },
    {
      id: "72000000-0000-4000-8000-000000000009",
      artifacts: [],
      storageMounts: [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "pinned",
          storageId: fixture.storageIds.pinned,
          version: "deadbeef",
          mountPath: "/home/oai/share/canonical-unresolved",
          writeback: true,
        },
      ],
    },
    {
      id: "72000000-0000-4000-8000-000000000010",
      artifacts: [
        {
          name: "rollback-latest",
          version: "latest",
          mountPath: "/home/oai/share/rollback-latest",
        },
      ],
      storageMounts: null,
    },
  ];

  for (const row of rows) {
    await client.query(
      `
        INSERT INTO "agent_sessions" (
          "id",
          "user_id",
          "org_id",
          "agent_compose_id",
          "artifacts",
          "storage_mounts"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      `,
      [
        row.id,
        fixture.userId,
        fixture.orgId,
        fixture.composeId,
        JSON.stringify(row.artifacts),
        row.storageMounts === null ? null : JSON.stringify(row.storageMounts),
      ],
    );
  }
}

async function validateSessionStorageBackfill(): Promise<void> {
  console.log(
    "=== Phase 1.7: Validate session continuation Storage backfill ===\n",
  );
  const successDb = "migration_session_storage_backfill_test";
  const successDbUrl = createTestDbUrl(successDb);

  await createDatabase(successDb);
  try {
    await runMigrationsUpTo(
      successDbUrl,
      SESSION_STORAGE_BACKFILL_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: successDbUrl });
    await client.connect();
    try {
      await seedSessionStorageBackfillFixture(client);
      await applyMigrationsUpToInTransaction(
        client,
        SESSION_STORAGE_BACKFILL_MIGRATION,
      );

      const result = await client.query<{
        artifacts: unknown;
        id: string;
        storage_mounts: unknown;
        updated_at: string;
      }>(`
        SELECT
          "id",
          "artifacts",
          "storage_mounts",
          "updated_at"::text
        FROM "agent_sessions"
        WHERE "id" IN (
          '${sessionStorageBackfillFixture.legacySessionId}',
          '${sessionStorageBackfillFixture.emptySessionId}',
          '${sessionStorageBackfillFixture.canonicalSessionId}',
          '${sessionStorageBackfillFixture.provenanceSessionId}',
          '${sessionStorageBackfillFixture.missingLatestSessionId}',
          '${sessionStorageBackfillFixture.missingImplicitLatestSessionId}'
        )
        ORDER BY "id"
      `);
      const rowsById = new Map(
        result.rows.map((row) => {
          return [row.id, row] as const;
        }),
      );
      const fixture = sessionStorageBackfillFixture;
      const legacy = rowsById.get(fixture.legacySessionId);
      assert.ok(legacy);
      assert.deepEqual(legacy.storage_mounts, [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: fixture.storageIds.head,
          mountPath: "/home/oai/share/head",
          writeback: true,
        },
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "latest",
          storageId: fixture.storageIds.latest,
          version: "latest",
          mountPath: "/home/oai/share/latest",
          writeback: true,
          missingRootPolicy: "preserveParentVersion",
        },
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "pinned",
          storageId: fixture.storageIds.pinned,
          version: fixture.versionIds.pinned,
          mountPath: "/home/oai/share/pinned",
          writeback: true,
        },
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "prefix",
          storageId: fixture.storageIds.prefix,
          version: fixture.versionIds.prefix.slice(0, 8),
          mountPath: "/home/oai/share/prefix",
          writeback: true,
        },
      ]);
      assert.deepEqual(legacy.artifacts, [
        { name: "head", mountPath: "/home/oai/share/head" },
        {
          name: "latest",
          version: "latest",
          mountPath: "/home/oai/share/latest",
          missingRootPolicy: "preserveParentVersion",
        },
        {
          name: "pinned",
          version: fixture.versionIds.pinned,
          mountPath: "/home/oai/share/pinned",
        },
        {
          name: "prefix",
          version: fixture.versionIds.prefix.slice(0, 8),
          mountPath: "/home/oai/share/prefix",
        },
      ]);
      assert.equal(legacy.updated_at, "2020-01-01 00:00:00");

      const empty = rowsById.get(fixture.emptySessionId);
      assert.ok(empty);
      assert.deepEqual(empty.storage_mounts, []);
      assert.equal(empty.updated_at, "2020-01-02 00:00:00");

      const canonical = rowsById.get(fixture.canonicalSessionId);
      assert.ok(canonical);
      assert.deepEqual(canonical.storage_mounts, [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: fixture.storageIds.head,
          mountPath: "/home/oai/share/head",
          writeback: true,
        },
      ]);
      assert.equal(canonical.updated_at, "2020-01-03 00:00:00");

      const provenance = rowsById.get(fixture.provenanceSessionId);
      assert.ok(provenance);
      assert.deepEqual(provenance.storage_mounts, [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "head",
          storageId: fixture.storageIds.head,
          mountPath: "/home/oai/share/provenance",
          writeback: true,
        },
      ]);
      assert.deepEqual(provenance.artifacts, [
        {
          name: "head",
          mountPath: "/home/oai/share/provenance",
          generatedBy: "apiAutoMemory",
        },
      ]);
      assert.equal(provenance.updated_at, "2020-01-04 00:00:00");

      const recreatedStorage = await client.query<{
        archive_size: number;
        created_by: string;
        file_count: number;
        head_version_id: string;
        id: string;
        message: string;
        name: string;
        s3_key: string;
        s3_prefix: string;
        size: number;
        type: string;
      }>(`
        SELECT
          storage."id",
          storage."name",
          storage."type",
          storage."s3_prefix",
          storage."head_version_id",
          version."s3_key",
          version."size"::integer,
          version."archive_size"::integer,
          version."file_count",
          version."message",
          version."created_by"
        FROM "storages" AS storage
        INNER JOIN "storage_versions" AS version
          ON version."id" = storage."head_version_id"
        WHERE storage."org_id" = '${fixture.orgId}'
          AND storage."user_id" = '${fixture.userId}'
          AND storage."name" = 'recreated'
      `);
      assert.equal(recreatedStorage.rows.length, 1);
      const recreatedStorageRow = recreatedStorage.rows[0];
      assert.ok(recreatedStorageRow);
      const recreatedStorageId = recreatedStorageRow.id;
      const expectedEmptyVersionId = createHash("sha256")
        .update(`storage:${recreatedStorageId}\n`)
        .digest("hex");
      assert.deepEqual(recreatedStorageRow, {
        id: recreatedStorageId,
        name: "recreated",
        type: "artifact",
        s3_prefix: `${fixture.orgId}/${recreatedStorageId}`,
        head_version_id: expectedEmptyVersionId,
        s3_key: `${fixture.orgId}/${recreatedStorageId}/${expectedEmptyVersionId}`,
        size: 0,
        archive_size: 0,
        file_count: 0,
        message: "Initial empty artifact",
        created_by: fixture.userId,
      });

      const recreatedLatest = rowsById.get(fixture.missingLatestSessionId);
      assert.ok(recreatedLatest);
      assert.deepEqual(recreatedLatest.storage_mounts, [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "recreated",
          storageId: recreatedStorageId,
          version: "latest",
          mountPath: "/home/oai/share/recreated-latest",
          writeback: true,
        },
      ]);
      assert.deepEqual(recreatedLatest.artifacts, [
        {
          name: "recreated",
          version: "latest",
          mountPath: "/home/oai/share/recreated-latest",
          generatedBy: "apiAutoMemory",
        },
      ]);
      assert.equal(recreatedLatest.updated_at, "2020-01-05 00:00:00");

      const recreatedImplicit = rowsById.get(
        fixture.missingImplicitLatestSessionId,
      );
      assert.ok(recreatedImplicit);
      assert.deepEqual(recreatedImplicit.storage_mounts, [
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: "recreated",
          storageId: recreatedStorageId,
          mountPath: "/home/oai/share/recreated-implicit",
          writeback: true,
        },
      ]);
      assert.deepEqual(recreatedImplicit.artifacts, [
        {
          name: "recreated",
          mountPath: "/home/oai/share/recreated-implicit",
        },
      ]);
      assert.equal(recreatedImplicit.updated_at, "2020-01-06 00:00:00");

      const unmigrated = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS "count"
        FROM "agent_sessions"
        WHERE "storage_mounts" IS NULL
      `);
      assert.equal(unmigrated.rows[0]?.count, 0);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(successDb);
  }

  const rejectionDb = "migration_session_storage_backfill_rejection_test";
  const rejectionDbUrl = createTestDbUrl(rejectionDb);
  await createDatabase(rejectionDb);
  try {
    await runMigrationsUpTo(
      rejectionDbUrl,
      SESSION_STORAGE_BACKFILL_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: rejectionDbUrl });
    await client.connect();
    try {
      await seedSessionStorageBackfillFixture(client);
      await seedSessionStorageBackfillRejections(client);

      const beforeRejection = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS "count"
        FROM "agent_sessions"
        WHERE "storage_mounts" IS NULL
      `);

      let rejection: unknown;
      try {
        await applyMigrationsUpToInTransaction(
          client,
          SESSION_STORAGE_BACKFILL_MIGRATION,
        );
      } catch (error) {
        rejection = error;
      }
      assert.equal(databaseErrorCode(rejection), "23514");
      assert.ok(
        rejection instanceof Error &&
          rejection.message.includes(
            "malformed_sessions=1, duplicate_sessions=1, missing_storage_sessions=1, unresolved_version_sessions=1, malformed_canonical_sessions=1, duplicate_canonical_sessions=1, stale_canonical_identity_sessions=1, unresolved_canonical_version_sessions=1, canonical_conflict_sessions=1",
          ),
      );

      const unchanged = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS "count"
        FROM "agent_sessions"
        WHERE "storage_mounts" IS NULL
      `);
      assert.equal(unchanged.rows[0]?.count, beforeRejection.rows[0]?.count);

      const rolledBackStorage = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS "count"
        FROM "storages"
        WHERE "org_id" = '${sessionStorageBackfillFixture.orgId}'
          AND "user_id" = '${sessionStorageBackfillFixture.userId}'
          AND "name" = 'rollback-latest'
      `);
      assert.equal(rolledBackStorage.rows[0]?.count, 0);

      const migrationRecord = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS "count"
        FROM "__drizzle_migrations"
        WHERE "hash" = '0654_backfill_session_continuation_storage_mounts'
      `);
      assert.equal(migrationRecord.rows[0]?.count, 0);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(rejectionDb);
  }

  console.log(
    "   ✅ Session continuation heads backfill losslessly and readiness failures roll back atomically\n",
  );
}

const LEGACY_MEMORY_CLEANUP_PREVIOUS_MIGRATION = 640;
const LEGACY_MEMORY_CLEANUP_MIGRATION = 641;

const legacyMemoryCleanupFixture = {
  orgId: "legacy-memory-cleanup-org",
  composeId: "60000000-0000-4000-8000-000000000001",
  sessionId: "60000000-0000-4000-8000-000000000002",
  runId: "60000000-0000-4000-8000-000000000003",
  targetStorageIds: [
    "c0ba5859-3f04-4e73-86af-f2ecfda38920",
    "40bcddf8-dded-4bd3-ba01-889aab237e2c",
    "a3cd07d8-ed1d-41eb-ad86-36eee81f439b",
    "bb526398-1475-44a1-bfe8-31de6492aa68",
    "09b476e2-a966-4c48-b04b-8c7ab525d427",
    "834c8df9-4755-4252-b0dd-4b1f96f257e6",
    "1ccfe6e9-f780-46f0-8174-f29b04808d08",
    "6ed6253f-6a87-4f62-95dd-6cf54eb019cc",
    "8612fe6d-ea43-4e13-8b37-40a77d9949d6",
    "cfea61f2-e97f-4726-8806-505454a4d175",
  ],
} as const;

function legacyMemoryVersionId(
  storageIndex: number,
  versionIndex: number,
): string {
  return `legacy-memory-${storageIndex}-${versionIndex}`.padEnd(64, "0");
}

async function seedLegacyMemoryCleanupFixture(
  client: Client,
  args: { readonly addUnexpectedVersion: boolean },
): Promise<void> {
  const fixture = legacyMemoryCleanupFixture;

  await client.query(
    `
      INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
      VALUES ($1, 'legacy-memory-cleanup-user', 'legacy-memory-cleanup', $2)
    `,
    [fixture.composeId, fixture.orgId],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions"
        ("id", "user_id", "org_id", "agent_compose_id")
      VALUES ($1, 'legacy-memory-cleanup-user', $2, $3)
    `,
    [fixture.sessionId, fixture.orgId, fixture.composeId],
  );
  await client.query(
    `
      INSERT INTO "agent_runs"
        ("id", "user_id", "session_id", "status", "prompt", "org_id")
      VALUES ($1, 'legacy-memory-cleanup-user', $2, 'completed', 'migration test', $3)
    `,
    [fixture.runId, fixture.sessionId, fixture.orgId],
  );

  for (const [storageIndex, storageId] of fixture.targetStorageIds.entries()) {
    await client.query(
      `
        INSERT INTO "storages"
          ("id", "user_id", "name", "type", "org_id", "s3_prefix", "updated_at")
        VALUES ($1, 'legacy-memory-cleanup-user', $2, 'memory', $3, $4, '2026-04-22 22:56:22.311')
      `,
      [
        storageId,
        `legacy-memory-${storageIndex}`,
        fixture.orgId,
        `legacy-memory-cleanup/${storageIndex}`,
      ],
    );

    const versionCount = storageIndex < 4 ? 2 : 1;
    for (let versionIndex = 0; versionIndex < versionCount; versionIndex += 1) {
      const versionId = legacyMemoryVersionId(storageIndex, versionIndex);
      await client.query(
        `
          INSERT INTO "storage_versions"
            ("id", "storage_id", "s3_key", "archive_size", "created_by")
          VALUES ($1, $2, $3, 0, 'migration-test')
        `,
        [
          versionId,
          storageId,
          `legacy-memory-cleanup/${storageIndex}/${versionId}`,
        ],
      );
    }

    if (storageIndex < 4) {
      await client.query(
        `
          INSERT INTO "storage_version_lineage"
            ("storage_id", "version_id", "parent_version_id", "run_id", "storage_type")
          VALUES ($1, $2, $3, $4, 'memory')
        `,
        [
          storageId,
          legacyMemoryVersionId(storageIndex, 1),
          legacyMemoryVersionId(storageIndex, 0),
          fixture.runId,
        ],
      );
    }
  }

  if (args.addUnexpectedVersion) {
    await client.query(
      `
        INSERT INTO "storage_versions"
          ("id", "storage_id", "s3_key", "archive_size", "created_by")
        VALUES ($1, $2, 'legacy-memory-cleanup/unexpected', 0, 'migration-test')
      `,
      ["legacy-memory-unexpected".padEnd(64, "0"), fixture.targetStorageIds[0]],
    );
  }
}

async function readLegacyMemoryCleanupCounts(client: Client): Promise<{
  readonly lineageCount: number;
  readonly storageCount: number;
  readonly versionCount: number;
}> {
  const fixture = legacyMemoryCleanupFixture;
  const result = await client.query<{
    lineageCount: number;
    storageCount: number;
    versionCount: number;
  }>(
    `
      SELECT
        (
          SELECT count(*)::integer
          FROM "storages"
          WHERE "id" = ANY($1::uuid[])
        ) AS "storageCount",
        (
          SELECT count(*)::integer
          FROM "storage_versions"
          WHERE "storage_id" = ANY($1::uuid[])
        ) AS "versionCount",
        (
          SELECT count(*)::integer
          FROM "storage_version_lineage"
          WHERE "storage_id" = ANY($1::uuid[])
        ) AS "lineageCount"
    `,
    [fixture.targetStorageIds],
  );
  const counts = result.rows[0];
  assert.ok(counts);
  return counts;
}

async function validateLegacyMemoryCleanup(): Promise<void> {
  console.log("=== Phase 1.75: Validate legacy memory cleanup ===\n");
  const cleanupDb = "migration_legacy_memory_cleanup_test";
  const cleanupDbUrl = createTestDbUrl(cleanupDb);

  await createDatabase(cleanupDb);
  try {
    await runMigrationsUpTo(
      cleanupDbUrl,
      LEGACY_MEMORY_CLEANUP_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: cleanupDbUrl });
    await client.connect();
    try {
      await seedLegacyMemoryCleanupFixture(client, {
        addUnexpectedVersion: false,
      });
      assert.deepEqual(await readLegacyMemoryCleanupCounts(client), {
        storageCount: 10,
        versionCount: 14,
        lineageCount: 4,
      });

      await applyMigrationsUpToInTransaction(
        client,
        LEGACY_MEMORY_CLEANUP_MIGRATION,
      );
      assert.deepEqual(await readLegacyMemoryCleanupCounts(client), {
        storageCount: 0,
        versionCount: 0,
        lineageCount: 0,
      });
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(cleanupDb);
  }

  const rejectionDb = "migration_legacy_memory_cleanup_rejection_test";
  const rejectionDbUrl = createTestDbUrl(rejectionDb);

  await createDatabase(rejectionDb);
  try {
    await runMigrationsUpTo(
      rejectionDbUrl,
      LEGACY_MEMORY_CLEANUP_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: rejectionDbUrl });
    await client.connect();
    try {
      await seedLegacyMemoryCleanupFixture(client, {
        addUnexpectedVersion: true,
      });

      try {
        await applyMigrationsUpToInTransaction(
          client,
          LEGACY_MEMORY_CLEANUP_MIGRATION,
        );
      } catch (error) {
        assert.equal(databaseErrorCode(error), "P0001");
        assert.ok(
          error instanceof Error &&
            error.message.includes(
              "expected 14 legacy memory storage versions, found 15",
            ),
        );
      }

      assert.deepEqual(await readLegacyMemoryCleanupCounts(client), {
        storageCount: 10,
        versionCount: 15,
        lineageCount: 4,
      });
      const migrationRecord = await client.query<{ count: number }>(
        `
          SELECT count(*)::integer AS "count"
          FROM "__drizzle_migrations"
          WHERE "hash" = '0641_delete_legacy_memory_storages'
        `,
      );
      assert.equal(migrationRecord.rows[0]?.count, 0);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(rejectionDb);
  }

  console.log(
    "   ✅ Legacy memory cleanup deletes verified rows and rejects unexpected state atomically\n",
  );
}

async function seedStorageArchiveSizeFinalizationFixture(
  client: Client,
): Promise<void> {
  const fixture = storageArchiveSizeFixture;

  await client.query(
    `
      INSERT INTO "storages"
        ("id", "org_id", "user_id", "name", "type", "s3_prefix", "size", "file_count")
      VALUES
        ($1, $2, '__org__', 'legacy-volume', 'volume', 'archive-finalization/legacy', 42, 1)
    `,
    [fixture.storageId, fixture.orgId],
  );

  await client.query(
    `
      INSERT INTO "storage_versions"
        ("id", "storage_id", "s3_key", "size", "archive_size", "file_count", "created_by", "created_at")
      VALUES
        ($1, $5, 'archive-finalization/positive', 7, 11, 1, 'test', '2025-01-01'),
        ($2, $5, 'archive-finalization/empty', 0, 0, 0, 'test', '2025-01-01'),
        ($3, $5, 'archive-finalization/head', 42, NULL, 1, 'test', '2025-01-01'),
        ($4, $5, 'archive-finalization/history', 24, NULL, 1, 'test', '2025-01-01')
    `,
    [
      fixture.positiveVersionId,
      fixture.emptyVersionId,
      fixture.headVersionId,
      fixture.historyVersionId,
      fixture.storageId,
    ],
  );

  await client.query(
    `
      UPDATE "storages"
      SET "head_version_id" = $1
      WHERE "id" = $2
    `,
    [fixture.headVersionId, fixture.storageId],
  );

  await client.query(
    `
      INSERT INTO "storage_archive_size_backfill_work"
        (
          "storage_version_id",
          "claim_token",
          "lease_expires_at",
          "attempt_count",
          "last_attempt_at",
          "outcome",
          "error_code"
        )
      VALUES
        ($1, '50000000-0000-4000-8000-000000000001', '2025-01-02', 1, '2025-01-02', 'missing', 'archive-not-found'),
        ($2, '50000000-0000-4000-8000-000000000002', '2025-01-02', 1, '2025-01-02', 'missing', 'archive-not-found')
    `,
    [fixture.headVersionId, fixture.historyVersionId],
  );
}

async function expectStorageArchiveSizeConstraintRejected(
  client: Client,
  args: {
    readonly versionId: string;
    readonly archiveSize: number | null;
    readonly expectedCode: "23502" | "23514";
    readonly expectedConstraint?: string;
  },
): Promise<void> {
  const fixture = storageArchiveSizeFixture;
  try {
    await client.query(
      `
        INSERT INTO "storage_versions"
          ("id", "storage_id", "s3_key", "archive_size", "file_count", "created_by")
        VALUES ($1, $2, $3, $4, 1, 'test')
      `,
      [
        args.versionId,
        fixture.storageId,
        `archive-finalization/rejected/${args.versionId}`,
        args.archiveSize,
      ],
    );
  } catch (error) {
    assert.equal(databaseErrorCode(error), args.expectedCode);
    if (args.expectedConstraint) {
      assert.ok(
        error instanceof Error &&
          error.message.includes(args.expectedConstraint),
      );
    }
    return;
  }

  throw new Error(`Storage archive-size constraint accepted ${args.versionId}`);
}

async function validateStorageArchiveSizeFinalization(): Promise<void> {
  console.log(
    "=== Phase 1.5: Validate storage archive-size finalization ===\n",
  );
  const testDb = "migration_storage_archive_size_finalization_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = storageArchiveSizeFixture;

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, STORAGE_ARCHIVE_SIZE_PREVIOUS_MIGRATION);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await seedStorageArchiveSizeFinalizationFixture(client);
      await applyMigrationsUpToInTransaction(
        client,
        STORAGE_ARCHIVE_SIZE_FINALIZATION_MIGRATION,
      );

      const versions = await client.query<{
        archive_size: string;
        file_count: number;
        id: string;
      }>(
        `
          SELECT "id", "archive_size", "file_count"
          FROM "storage_versions"
          WHERE "storage_id" = $1
          ORDER BY "id"
        `,
        [fixture.storageId],
      );
      assert.deepEqual(versions.rows, [
        {
          id: fixture.positiveVersionId,
          archive_size: "11",
          file_count: 1,
        },
        {
          id: fixture.emptyVersionId,
          archive_size: "0",
          file_count: 0,
        },
        {
          id: fixture.headVersionId,
          archive_size: "0",
          file_count: 1,
        },
        {
          id: fixture.historyVersionId,
          archive_size: "0",
          file_count: 1,
        },
      ]);

      const storage = await client.query<{
        file_count: number;
        head_version_id: string | null;
        size: string;
      }>(
        `
          SELECT "head_version_id", "size", "file_count"
          FROM "storages"
          WHERE "id" = $1
        `,
        [fixture.storageId],
      );
      assert.deepEqual(storage.rows, [
        {
          head_version_id: fixture.headVersionId,
          size: "42",
          file_count: 1,
        },
      ]);

      const finalState = await client.query<{
        archive_size_nullable: string;
        null_archive_sizes: string;
        null_index: string | null;
        work_table: string | null;
      }>(`
        SELECT
          (
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'storage_versions'
              AND column_name = 'archive_size'
          ) AS archive_size_nullable,
          (
            SELECT count(*)::text
            FROM storage_versions
            WHERE archive_size IS NULL
          ) AS null_archive_sizes,
          to_regclass('public.idx_storage_versions_archive_size_null')::text
            AS null_index,
          to_regclass('public.storage_archive_size_backfill_work')::text
            AS work_table
      `);
      assert.deepEqual(finalState.rows, [
        {
          archive_size_nullable: "NO",
          null_archive_sizes: "0",
          null_index: null,
          work_table: null,
        },
      ]);

      const finalConstraints = await client.query<{ conname: string }>(`
        SELECT conname
        FROM pg_constraint
        WHERE conname IN (
          'chk_storage_versions_archive_size_nonnegative',
          'chk_storage_versions_nonempty_archive_size_positive'
        )
        ORDER BY conname
      `);
      assert.deepEqual(
        finalConstraints.rows.map((row) => {
          return row.conname;
        }),
        ["chk_storage_versions_archive_size_nonnegative"],
      );

      await expectStorageArchiveSizeConstraintRejected(client, {
        versionId: "e".repeat(64),
        archiveSize: null,
        expectedCode: "23502",
      });
      await expectStorageArchiveSizeConstraintRejected(client, {
        versionId: "f".repeat(64),
        archiveSize: -1,
        expectedCode: "23514",
        expectedConstraint: "chk_storage_versions_archive_size_nonnegative",
      });
    } finally {
      await client.end();
    }
    console.log(
      "   ✅ Finalization normalizes legacy null sizes, preserves storage metadata, and installs the final constraints\n",
    );
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateStorageLegacyTypeContraction(): Promise<void> {
  console.log("=== Phase 1.55: Validate Storage legacy type contraction ===\n");
  const testDb = "migration_storage_legacy_type_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  const storageId = "52000000-0000-4000-8000-000000000001";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 695);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "storages" (
            "id",
            "user_id",
            "name",
            "type",
            "org_id",
            "s3_prefix"
          )
          VALUES ($1, 'storage-contraction-user', 'storage-contraction', 'volume', 'storage-contraction-org', 'legacy-prefix')
        `,
        [storageId],
      );

      await applyMigrationsUpTo(client, 696);

      const legacyColumns = await client.query<{ column_name: string }>(`
        SELECT "column_name"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND (
            ("table_name" = 'storages' AND "column_name" = 'type')
            OR (
              "table_name" = 'storage_version_lineage'
              AND "column_name" = 'storage_type'
            )
          )
      `);
      assert.deepEqual(legacyColumns.rows, []);

      const identityIndexes = await client.query<{ indexname: string }>(`
        SELECT "indexname"
        FROM "pg_indexes"
        WHERE "schemaname" = 'public'
          AND "tablename" = 'storages'
          AND "indexname" IN (
            'idx_storages_org_user_name',
            'idx_storages_org_user_name_type'
          )
        ORDER BY "indexname"
      `);
      assert.deepEqual(identityIndexes.rows, [
        { indexname: "idx_storages_org_user_name" },
      ]);

      const upserted = await client.query<{
        id: string;
        s3_prefix: string;
      }>(`
        INSERT INTO "storages" (
          "user_id",
          "name",
          "org_id",
          "s3_prefix"
        )
        VALUES (
          'storage-contraction-user',
          'storage-contraction',
          'storage-contraction-org',
          'canonical-prefix'
        )
        ON CONFLICT ("org_id", "user_id", "name")
        DO UPDATE SET "s3_prefix" = EXCLUDED."s3_prefix"
        RETURNING "id", "s3_prefix"
      `);
      assert.deepEqual(upserted.rows, [
        { id: storageId, s3_prefix: "canonical-prefix" },
      ]);

      console.log(
        "   ✅ Legacy type columns and index are removed while canonical writes and existing Storage rows remain valid\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const CONNECTOR_SLUG_TEST_AGENT_ID = "71000000-0000-4000-8000-000000000099";
const CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID =
  "71000000-0000-4000-8000-000000000098";
const CONNECTOR_SLUG_CUTOVER_CUSTOM_CONNECTION_ID =
  "71000000-0000-4000-8000-000000000093";
const CONNECTOR_SLUG_CUTOVER_CUSTOM_OAUTH_STATE_ID =
  "71000000-0000-4000-8000-000000000094";
const CONNECTOR_SLUG_CONTRACTION_PREDECESSOR = 761;
const CONNECTOR_SLUG_CONTRACTION_MIGRATION = 762;
const connectorSlugCutoverInsertIds = {
  connector_external_code_sessions: "71000000-0000-4000-8000-000000000091",
  connector_oauth_device_authorization_sessions:
    "71000000-0000-4000-8000-000000000090",
  connector_oauth_states: "71000000-0000-4000-8000-000000000089",
  connectors: "71000000-0000-4000-8000-000000000087",
  user_connectors: "71000000-0000-4000-8000-000000000088",
  user_permission_grants: "71000000-0000-4000-8000-000000000092",
} as const;

async function validateCutoverReleaseAgainstBridgeSchema(
  client: Client,
): Promise<void> {
  const database = drizzle(client);

  assert.deepEqual(
    await database
      .insert(connectors)
      .values({
        id: connectorSlugCutoverInsertIds.connectors,
        connectorSlug: "cutover-google-drive",
        authMethod: "oauth",
        storageVersion: 1,
        userId: "connector-slug-cutover-connector-user",
        orgId: "connector-slug-org",
      })
      .returning({ id: connectors.id }),
    [{ id: connectorSlugCutoverInsertIds.connectors }],
  );
  assert.deepEqual(
    await database
      .insert(userConnectors)
      .values({
        id: connectorSlugCutoverInsertIds.user_connectors,
        orgId: "connector-slug-org",
        userId: "connector-slug-cutover-user-connector-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "cutover-google-calendar",
      })
      .returning({ id: userConnectors.id }),
    [{ id: connectorSlugCutoverInsertIds.user_connectors }],
  );
  assert.deepEqual(
    await database
      .insert(connectorOauthStates)
      .values({
        id: connectorSlugCutoverInsertIds.connector_oauth_states,
        state: "connector-slug-cutover-state",
        connectorSlug: "cutover-gmail",
        authMethod: "oauth",
        userId: "connector-slug-cutover-oauth-state-user",
        orgId: "connector-slug-org",
        redirectUri: "https://example.com/cutover/callback",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({ id: connectorOauthStates.id }),
    [{ id: connectorSlugCutoverInsertIds.connector_oauth_states }],
  );
  assert.deepEqual(
    await database
      .insert(connectorOauthDeviceAuthorizationSessions)
      .values({
        id: connectorSlugCutoverInsertIds.connector_oauth_device_authorization_sessions,
        orgId: "connector-slug-org",
        userId: "connector-slug-cutover-device-user",
        connectorSlug: "cutover-youtube",
        authMethod: "oauth-device",
        sessionTokenHash: "connector-slug-cutover-device-token",
        encryptedProviderState: "connector-slug-cutover-device-state",
        userCode: "CUTOVER",
        verificationUri: "https://example.com/cutover/device",
        intervalSeconds: 5,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({
        id: connectorOauthDeviceAuthorizationSessions.id,
      }),
    [
      {
        id: connectorSlugCutoverInsertIds.connector_oauth_device_authorization_sessions,
      },
    ],
  );
  assert.deepEqual(
    await database
      .insert(connectorExternalCodeSessions)
      .values({
        id: connectorSlugCutoverInsertIds.connector_external_code_sessions,
        orgId: "connector-slug-org",
        userId: "connector-slug-cutover-external-code-user",
        connectorSlug: "cutover-x",
        authMethod: "external-code",
        sessionTokenHash: "connector-slug-cutover-external-code-token",
        encryptedProviderState: "connector-slug-cutover-external-code-state",
        authorizationUrl: "https://example.com/cutover/authorize",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({
        id: connectorExternalCodeSessions.id,
      }),
    [
      {
        id: connectorSlugCutoverInsertIds.connector_external_code_sessions,
      },
    ],
  );
  assert.deepEqual(
    await database
      .insert(userPermissionGrants)
      .values({
        id: connectorSlugCutoverInsertIds.user_permission_grants,
        orgId: "connector-slug-org",
        userId: "connector-slug-cutover-permission-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "cutover-slack",
        permission: "channels:history",
        action: "allow",
      })
      .returning({
        id: userPermissionGrants.id,
      }),
    [{ id: connectorSlugCutoverInsertIds.user_permission_grants }],
  );

  assert.deepEqual(
    await database
      .select({ connectorSlug: connectors.connectorSlug })
      .from(connectors)
      .where(eq(connectors.id, connectorSlugCutoverInsertIds.connectors)),
    [{ connectorSlug: "cutover-google-drive" }],
  );
  assert.deepEqual(
    await database
      .select({ connectorSlug: userConnectors.connectorSlug })
      .from(userConnectors)
      .where(
        eq(userConnectors.id, connectorSlugCutoverInsertIds.user_connectors),
      ),
    [{ connectorSlug: "cutover-google-calendar" }],
  );
  assert.deepEqual(
    await database
      .select({ connectorSlug: connectorOauthStates.connectorSlug })
      .from(connectorOauthStates)
      .where(
        eq(
          connectorOauthStates.id,
          connectorSlugCutoverInsertIds.connector_oauth_states,
        ),
      ),
    [{ connectorSlug: "cutover-gmail" }],
  );
  assert.deepEqual(
    await database
      .select({
        connectorSlug: connectorOauthDeviceAuthorizationSessions.connectorSlug,
      })
      .from(connectorOauthDeviceAuthorizationSessions)
      .where(
        eq(
          connectorOauthDeviceAuthorizationSessions.id,
          connectorSlugCutoverInsertIds.connector_oauth_device_authorization_sessions,
        ),
      ),
    [{ connectorSlug: "cutover-youtube" }],
  );
  assert.deepEqual(
    await database
      .select({ connectorSlug: connectorExternalCodeSessions.connectorSlug })
      .from(connectorExternalCodeSessions)
      .where(
        eq(
          connectorExternalCodeSessions.id,
          connectorSlugCutoverInsertIds.connector_external_code_sessions,
        ),
      ),
    [{ connectorSlug: "cutover-x" }],
  );
  assert.deepEqual(
    await database
      .select({ connectorSlug: userPermissionGrants.connectorSlug })
      .from(userPermissionGrants)
      .where(
        eq(
          userPermissionGrants.id,
          connectorSlugCutoverInsertIds.user_permission_grants,
        ),
      ),
    [{ connectorSlug: "cutover-slack" }],
  );

  assert.equal(
    (
      await database
        .update(connectors)
        .set({ connectorSlug: "cutover-google-drive" })
        .where(eq(connectors.id, connectorSlugCutoverInsertIds.connectors))
        .returning({ id: connectors.id })
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(userConnectors)
        .set({ connectorSlug: "cutover-google-calendar" })
        .where(
          eq(userConnectors.id, connectorSlugCutoverInsertIds.user_connectors),
        )
        .returning({ id: userConnectors.id })
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectorOauthStates)
        .set({ connectorSlug: "cutover-gmail" })
        .where(
          eq(
            connectorOauthStates.id,
            connectorSlugCutoverInsertIds.connector_oauth_states,
          ),
        )
        .returning({ id: connectorOauthStates.id })
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectorOauthDeviceAuthorizationSessions)
        .set({ connectorSlug: "cutover-youtube" })
        .where(
          eq(
            connectorOauthDeviceAuthorizationSessions.id,
            connectorSlugCutoverInsertIds.connector_oauth_device_authorization_sessions,
          ),
        )
        .returning({ id: connectorOauthDeviceAuthorizationSessions.id })
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectorExternalCodeSessions)
        .set({ connectorSlug: "cutover-x" })
        .where(
          eq(
            connectorExternalCodeSessions.id,
            connectorSlugCutoverInsertIds.connector_external_code_sessions,
          ),
        )
        .returning({ id: connectorExternalCodeSessions.id })
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(userPermissionGrants)
        .set({ connectorSlug: "cutover-slack" })
        .where(
          eq(
            userPermissionGrants.id,
            connectorSlugCutoverInsertIds.user_permission_grants,
          ),
        )
        .returning({ id: userPermissionGrants.id })
    ).length,
    1,
  );

  assert.deepEqual(
    await database
      .insert(connectors)
      .values({
        connectorSlug: "cutover-google-drive",
        authMethod: "oauth",
        storageVersion: 2,
        userId: "connector-slug-cutover-connector-user",
        orgId: "connector-slug-org",
      })
      .onConflictDoUpdate({
        target: [connectors.orgId, connectors.userId, connectors.connectorSlug],
        targetWhere: isNotNull(connectors.connectorSlug),
        set: { storageVersion: 2 },
      })
      .returning({ id: connectors.id }),
    [{ id: connectorSlugCutoverInsertIds.connectors }],
  );
  assert.deepEqual(
    await database
      .insert(userConnectors)
      .values({
        orgId: "connector-slug-org",
        userId: "connector-slug-cutover-user-connector-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "cutover-google-calendar",
      })
      .onConflictDoNothing({
        target: [
          userConnectors.orgId,
          userConnectors.userId,
          userConnectors.agentId,
          userConnectors.connectorSlug,
        ],
      })
      .returning({ id: userConnectors.id }),
    [],
  );
  assert.deepEqual(
    await database
      .insert(userPermissionGrants)
      .values({
        orgId: "connector-slug-org",
        userId: "connector-slug-cutover-permission-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "cutover-slack",
        permission: "channels:history",
        action: "deny",
      })
      .onConflictDoNothing({
        target: [
          userPermissionGrants.orgId,
          userPermissionGrants.userId,
          userPermissionGrants.agentId,
          userPermissionGrants.connectorSlug,
          userPermissionGrants.permission,
        ],
      })
      .returning({
        id: userPermissionGrants.id,
      }),
    [],
  );

  const customConnectorId = CONNECTOR_SLUG_CUTOVER_CUSTOM_CONNECTION_ID;
  const customOauthStateId = CONNECTOR_SLUG_CUTOVER_CUSTOM_OAUTH_STATE_ID;
  await database.insert(connectors).values({
    id: customConnectorId,
    customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
    authMethod: "oauth2",
    storageVersion: 1,
    userId: "connector-slug-cutover-custom-user",
    orgId: "connector-slug-org",
  });
  await database.insert(connectorOauthStates).values({
    id: customOauthStateId,
    state: "connector-slug-cutover-custom-state",
    customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
    connectorRevision: 1,
    authMethod: "oauth2",
    userId: "connector-slug-cutover-custom-user",
    orgId: "connector-slug-org",
    redirectUri: "https://example.com/cutover/custom/callback",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  const customConnection = await client.query<{
    readonly connectorSlug: string | null;
    readonly legacyType: string | null;
  }>(
    `
      SELECT
        "connector_slug" AS "connectorSlug",
        "type" AS "legacyType"
      FROM "connectors"
      WHERE "id" = $1
    `,
    [customConnectorId],
  );
  assert.deepEqual(customConnection.rows, [
    { connectorSlug: null, legacyType: null },
  ]);
  const customOauthState = await client.query<{
    readonly connectorSlug: string | null;
    readonly legacyType: string | null;
  }>(
    `
      SELECT
        "connector_slug" AS "connectorSlug",
        "type" AS "legacyType"
      FROM "connector_oauth_states"
      WHERE "id" = $1
    `,
    [customOauthStateId],
  );
  assert.deepEqual(customOauthState.rows, [
    { connectorSlug: null, legacyType: null },
  ]);
}

async function validateFinalConnectorSlugWrites(client: Client): Promise<void> {
  const database = drizzle(client);
  const ids = {
    connector: "71000000-0000-4000-8000-000000000071",
    customConnector: "71000000-0000-4000-8000-000000000070",
    customOauthState: "71000000-0000-4000-8000-000000000069",
    externalCodeSession: "71000000-0000-4000-8000-000000000075",
    oauthDeviceSession: "71000000-0000-4000-8000-000000000073",
    oauthState: "71000000-0000-4000-8000-000000000072",
    userConnector: "71000000-0000-4000-8000-000000000074",
    userPermissionGrant: "71000000-0000-4000-8000-000000000076",
  } as const;

  assert.deepEqual(
    await database
      .insert(connectors)
      .values({
        id: ids.connector,
        connectorSlug: "final-google-drive",
        authMethod: "oauth",
        storageVersion: 1,
        userId: "connector-slug-final-connector-user",
        orgId: "connector-slug-org",
      })
      .returning({ id: connectors.id }),
    [{ id: ids.connector }],
  );
  assert.deepEqual(
    await database
      .insert(userConnectors)
      .values({
        id: ids.userConnector,
        orgId: "connector-slug-org",
        userId: "connector-slug-final-user-connector-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "final-google-calendar",
      })
      .returning({ id: userConnectors.id }),
    [{ id: ids.userConnector }],
  );
  assert.deepEqual(
    await database
      .insert(connectorOauthStates)
      .values({
        id: ids.oauthState,
        state: "connector-slug-final-state",
        connectorSlug: "final-gmail",
        authMethod: "oauth",
        userId: "connector-slug-final-oauth-state-user",
        orgId: "connector-slug-org",
        redirectUri: "https://example.com/final/callback",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({ id: connectorOauthStates.id }),
    [{ id: ids.oauthState }],
  );
  assert.deepEqual(
    await database
      .insert(connectorOauthDeviceAuthorizationSessions)
      .values({
        id: ids.oauthDeviceSession,
        orgId: "connector-slug-org",
        userId: "connector-slug-final-device-user",
        connectorSlug: "final-youtube",
        authMethod: "oauth-device",
        sessionTokenHash: "connector-slug-final-device-token",
        encryptedProviderState: "connector-slug-final-device-state",
        userCode: "FINAL",
        verificationUri: "https://example.com/final/device",
        intervalSeconds: 5,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({ id: connectorOauthDeviceAuthorizationSessions.id }),
    [{ id: ids.oauthDeviceSession }],
  );
  assert.deepEqual(
    await database
      .insert(connectorExternalCodeSessions)
      .values({
        id: ids.externalCodeSession,
        orgId: "connector-slug-org",
        userId: "connector-slug-final-external-code-user",
        connectorSlug: "final-x",
        authMethod: "external-code",
        sessionTokenHash: "connector-slug-final-external-code-token",
        encryptedProviderState: "connector-slug-final-external-code-state",
        authorizationUrl: "https://example.com/final/authorize",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({ id: connectorExternalCodeSessions.id }),
    [{ id: ids.externalCodeSession }],
  );
  assert.deepEqual(
    await database
      .insert(userPermissionGrants)
      .values({
        id: ids.userPermissionGrant,
        orgId: "connector-slug-org",
        userId: "connector-slug-final-permission-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "final-slack",
        permission: "channels:history",
        action: "allow",
      })
      .returning({ id: userPermissionGrants.id }),
    [{ id: ids.userPermissionGrant }],
  );

  assert.deepEqual(
    await database
      .insert(connectors)
      .values({
        connectorSlug: "final-google-drive",
        authMethod: "oauth",
        storageVersion: 2,
        userId: "connector-slug-final-connector-user",
        orgId: "connector-slug-org",
      })
      .onConflictDoUpdate({
        target: [connectors.orgId, connectors.userId, connectors.connectorSlug],
        targetWhere: isNotNull(connectors.connectorSlug),
        set: { storageVersion: 2 },
      })
      .returning({
        id: connectors.id,
        storageVersion: connectors.storageVersion,
      }),
    [{ id: ids.connector, storageVersion: 2 }],
  );
  assert.deepEqual(
    await database
      .insert(userConnectors)
      .values({
        orgId: "connector-slug-org",
        userId: "connector-slug-final-user-connector-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "final-google-calendar",
      })
      .onConflictDoNothing({
        target: [
          userConnectors.orgId,
          userConnectors.userId,
          userConnectors.agentId,
          userConnectors.connectorSlug,
        ],
      })
      .returning({ id: userConnectors.id }),
    [],
  );
  assert.deepEqual(
    await database
      .insert(userPermissionGrants)
      .values({
        orgId: "connector-slug-org",
        userId: "connector-slug-final-permission-user",
        agentId: CONNECTOR_SLUG_TEST_AGENT_ID,
        connectorSlug: "final-slack",
        permission: "channels:history",
        action: "deny",
      })
      .onConflictDoNothing({
        target: [
          userPermissionGrants.orgId,
          userPermissionGrants.userId,
          userPermissionGrants.agentId,
          userPermissionGrants.connectorSlug,
          userPermissionGrants.permission,
        ],
      })
      .returning({ id: userPermissionGrants.id }),
    [],
  );

  assert.deepEqual(
    await database
      .insert(connectors)
      .values({
        id: ids.customConnector,
        customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
        authMethod: "oauth2",
        storageVersion: 1,
        userId: "connector-slug-final-custom-user",
        orgId: "connector-slug-org",
      })
      .returning({
        connectorSlug: connectors.connectorSlug,
        customConnectorId: connectors.customConnectorId,
      }),
    [
      {
        connectorSlug: null,
        customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
      },
    ],
  );
  assert.deepEqual(
    await database
      .insert(connectorOauthStates)
      .values({
        id: ids.customOauthState,
        state: "connector-slug-final-custom-state",
        customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
        connectorRevision: 1,
        authMethod: "oauth2",
        userId: "connector-slug-final-custom-user",
        orgId: "connector-slug-org",
        redirectUri: "https://example.com/final/custom/callback",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({
        connectorSlug: connectorOauthStates.connectorSlug,
        customConnectorId: connectorOauthStates.customConnectorId,
      }),
    [
      {
        connectorSlug: null,
        customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
      },
    ],
  );

  await expectDatabaseError(client, {
    code: "23514",
    query: `
      INSERT INTO "connectors" (
        "auth_method",
        "storage_version",
        "user_id",
        "org_id"
      )
      VALUES ('oauth', 1, 'connector-slug-final-no-identity', 'connector-slug-org')
    `,
  });
  await expectDatabaseError(client, {
    code: "23514",
    query: `
      INSERT INTO "connectors" (
        "connector_slug",
        "custom_connector_id",
        "auth_method",
        "storage_version",
        "user_id",
        "org_id"
      )
      VALUES (
        'final-invalid',
        $1,
        'oauth',
        1,
        'connector-slug-final-dual-identity',
        'connector-slug-org'
      )
    `,
    values: [CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID],
  });
  await expectDatabaseError(client, {
    code: "23514",
    query: `
      INSERT INTO "connector_oauth_states" (
        "state",
        "auth_method",
        "user_id",
        "org_id",
        "redirect_uri",
        "expires_at"
      )
      VALUES (
        'connector-slug-final-no-state-identity',
        'oauth',
        'connector-slug-final-no-state-identity',
        'connector-slug-org',
        'https://example.com/final/invalid',
        '2030-01-01T00:00:00.000Z'
      )
    `,
  });
  await expectDatabaseError(client, {
    code: "23514",
    query: `
      INSERT INTO "connector_oauth_states" (
        "state",
        "connector_slug",
        "custom_connector_id",
        "connector_revision",
        "auth_method",
        "user_id",
        "org_id",
        "redirect_uri",
        "expires_at"
      )
      VALUES (
        'connector-slug-final-dual-state-identity',
        'final-invalid',
        $1,
        1,
        'oauth2',
        'connector-slug-final-dual-state-identity',
        'connector-slug-org',
        'https://example.com/final/invalid',
        '2030-01-01T00:00:00.000Z'
      )
    `,
    values: [CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID],
  });
}

async function validateConnectorSlugRollout(): Promise<void> {
  console.log("=== Phase 1.6: Validate connector slug contraction ===\n");
  const testDb = "migration_connector_slug_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, CONNECTOR_SLUG_CONTRACTION_PREDECESSOR);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'connector-slug-owner', 'connector-slug-agent', 'connector-slug-org')
        `,
        [CONNECTOR_SLUG_TEST_AGENT_ID],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, 'connector-slug-org', 'connector-slug-owner', 'connector-slug-agent')
        `,
        [CONNECTOR_SLUG_TEST_AGENT_ID],
      );
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
          )
          VALUES (
            $1,
            'connector-slug-org',
            '_connector_slug_custom',
            'Connector Slug Custom',
            '[]'::jsonb,
            'Authorization',
            'Bearer {{secret}}',
            'oauth',
            'connector-slug-owner'
          )
        `,
        [CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID],
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
          )
          VALUES (
            $1,
            'connector-slug-org',
            'standard',
            'connector-slug-client',
            'connector-slug-encrypted-secret',
            'https://example.com/custom/authorize',
            'https://example.com/custom/token',
            'client_secret_basic',
            'none'
          )
        `,
        [CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID],
      );
      await client.query("COMMIT");

      await validateCutoverReleaseAgainstBridgeSchema(client);

      const canonicalNullability = await client.query<{
        readonly isNullable: "NO" | "YES";
        readonly tableName: string;
      }>(
        `
          SELECT
            "table_name" AS "tableName",
            "is_nullable" AS "isNullable"
          FROM "information_schema"."columns"
          WHERE "table_schema" = current_schema()
            AND "column_name" = 'connector_slug'
            AND "table_name" = ANY(ARRAY[
              'connector_external_code_sessions',
              'connector_oauth_device_authorization_sessions',
              'connector_oauth_states',
              'connectors',
              'user_connectors',
              'user_permission_grants'
            ])
          ORDER BY "table_name"
        `,
      );
      assert.deepEqual(canonicalNullability.rows, [
        {
          isNullable: "NO",
          tableName: "connector_external_code_sessions",
        },
        {
          isNullable: "NO",
          tableName: "connector_oauth_device_authorization_sessions",
        },
        { isNullable: "YES", tableName: "connector_oauth_states" },
        { isNullable: "YES", tableName: "connectors" },
        { isNullable: "NO", tableName: "user_connectors" },
        { isNullable: "NO", tableName: "user_permission_grants" },
      ]);

      const expectedFunctions = [
        "sync_connector_slug_from_connector_ref",
        "sync_connector_slug_from_connector_type",
        "sync_connector_slug_from_type",
      ];
      const functions = await client.query<{ readonly name: string }>(`
        SELECT "proname" AS "name"
        FROM "pg_proc"
        JOIN "pg_namespace" ON "pg_namespace"."oid" = "pg_proc"."pronamespace"
        WHERE "pg_namespace"."nspname" = current_schema()
          AND "proname" = ANY(ARRAY[
            'sync_connector_slug_from_connector_ref',
            'sync_connector_slug_from_connector_type',
            'sync_connector_slug_from_type'
          ])
        ORDER BY "proname"
      `);
      assert.deepEqual(
        functions.rows.map((row) => {
          return row.name;
        }),
        expectedFunctions,
      );

      const expectedTriggers = [
        "sync_connector_external_code_sessions_connector_slug",
        "sync_connector_oauth_device_sessions_connector_slug",
        "sync_connector_oauth_states_connector_slug",
        "sync_connectors_connector_slug",
        "sync_user_connectors_connector_slug",
        "sync_user_permission_grants_connector_slug",
      ];
      const triggers = await client.query<{
        readonly definition: string;
        readonly name: string;
      }>(`
        SELECT
          "tgname" AS "name",
          pg_get_triggerdef("pg_trigger"."oid") AS "definition"
        FROM "pg_trigger"
        JOIN "pg_class" ON "pg_class"."oid" = "pg_trigger"."tgrelid"
        JOIN "pg_namespace" ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = current_schema()
          AND NOT "tgisinternal"
          AND "tgname" LIKE 'sync_%_connector_slug'
        ORDER BY "tgname"
      `);
      assert.deepEqual(
        triggers.rows.map((row) => {
          return row.name;
        }),
        expectedTriggers,
      );
      const expectedTriggerUpdateColumns = new Map([
        [
          "sync_connector_external_code_sessions_connector_slug",
          "UPDATE OF connector_type, connector_slug",
        ],
        [
          "sync_connector_oauth_device_sessions_connector_slug",
          "UPDATE OF connector_type, connector_slug",
        ],
        [
          "sync_connector_oauth_states_connector_slug",
          "UPDATE OF type, connector_slug",
        ],
        ["sync_connectors_connector_slug", "UPDATE OF type, connector_slug"],
        [
          "sync_user_connectors_connector_slug",
          "UPDATE OF connector_type, connector_slug",
        ],
        [
          "sync_user_permission_grants_connector_slug",
          "UPDATE OF connector_ref, connector_slug",
        ],
      ]);
      assert.ok(
        triggers.rows.every((row) => {
          const expectedColumns = expectedTriggerUpdateColumns.get(row.name);
          assert.ok(expectedColumns);
          return row.definition.includes(
            `BEFORE INSERT OR ${expectedColumns} ON`,
          );
        }),
      );

      const expectedChecks = [
        "chk_connector_external_code_sessions_slug_matches_type",
        "chk_connector_oauth_device_sessions_slug_matches_type",
        "chk_connector_oauth_states_slug_matches_type",
        "chk_connectors_connector_slug_matches_type",
        "chk_user_connectors_slug_matches_type",
        "chk_user_permission_grants_slug_matches_ref",
      ];
      const checks = await client.query<{
        readonly name: string;
        readonly validated: boolean;
      }>(`
        SELECT
          "conname" AS "name",
          "convalidated" AS "validated"
        FROM "pg_constraint"
        JOIN "pg_class" ON "pg_class"."oid" = "pg_constraint"."conrelid"
        JOIN "pg_namespace" ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = current_schema()
          AND "contype" = 'c'
          AND "conname" = ANY(ARRAY[
            'chk_connector_external_code_sessions_slug_matches_type',
            'chk_connector_oauth_device_sessions_slug_matches_type',
            'chk_connector_oauth_states_slug_matches_type',
            'chk_connectors_connector_slug_matches_type',
            'chk_user_connectors_slug_matches_type',
            'chk_user_permission_grants_slug_matches_ref'
          ])
        ORDER BY "conname"
      `);
      assert.deepEqual(
        checks.rows.map((row) => {
          return row.name;
        }),
        expectedChecks,
      );
      assert.ok(
        checks.rows.every((row) => {
          return row.validated;
        }),
      );

      const expectedIndexes = [
        "idx_connector_external_code_sessions_owner_slug_status",
        "idx_connector_oauth_device_sessions_owner_slug_status",
        "idx_connectors_org_user_slug",
        "idx_user_connectors_unique_slug",
        "uq_user_permission_grants_slug_permission",
      ];
      const indexes = await client.query<{
        readonly definition: string;
        readonly name: string;
      }>(`
        SELECT
          "indexname" AS "name",
          "indexdef" AS "definition"
        FROM "pg_indexes"
        WHERE "schemaname" = current_schema()
          AND "indexname" = ANY(ARRAY[
            'idx_connector_external_code_sessions_owner_slug_status',
            'idx_connector_oauth_device_sessions_owner_slug_status',
            'idx_connectors_org_user_slug',
            'idx_user_connectors_unique_slug',
            'uq_user_permission_grants_slug_permission'
          ])
        ORDER BY "indexname"
      `);
      assert.deepEqual(
        indexes.rows.map((row) => {
          return row.name;
        }),
        expectedIndexes,
      );
      assert.ok(
        indexes.rows.every((row) => {
          return row.definition.includes("connector_slug");
        }),
      );

      await client.query(
        `CREATE INDEX "idx_connectors_unexpected_legacy_type_expression"
          ON "connectors" (lower("type"))`,
      );
      let unexpectedDependencyRejected = false;
      try {
        await applyMigrationsUpTo(client, CONNECTOR_SLUG_CONTRACTION_MIGRATION);
      } catch (error) {
        assert.equal(databaseErrorCode(error), "P0001");
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes(
            "unexpected legacy connector identity dependencies",
          ),
        );
        unexpectedDependencyRejected = true;
      }
      assert.ok(unexpectedDependencyRejected);
      await client.query(
        `DROP INDEX "idx_connectors_unexpected_legacy_type_expression"`,
      );

      await applyMigrationsUpTo(client, CONNECTOR_SLUG_CONTRACTION_MIGRATION);

      const removedColumns = await client.query<{
        readonly columnName: string;
        readonly tableName: string;
      }>(`
        SELECT
          "table_name" AS "tableName",
          "column_name" AS "columnName"
        FROM "information_schema"."columns"
        WHERE "table_schema" = current_schema()
          AND (
            ("table_name" = 'connectors' AND "column_name" = 'type')
            OR (
              "table_name" = 'user_connectors'
              AND "column_name" = 'connector_type'
            )
            OR (
              "table_name" = 'connector_oauth_states'
              AND "column_name" = 'type'
            )
            OR (
              "table_name" = 'connector_oauth_device_authorization_sessions'
              AND "column_name" = 'connector_type'
            )
            OR (
              "table_name" = 'connector_external_code_sessions'
              AND "column_name" = 'connector_type'
            )
            OR (
              "table_name" = 'user_permission_grants'
              AND "column_name" = 'connector_ref'
            )
          )
      `);
      assert.deepEqual(removedColumns.rows, []);

      const removedBridgeTriggers = await client.query<{
        readonly name: string;
      }>(`
        SELECT "tgname" AS "name"
        FROM "pg_trigger"
        WHERE "tgname" = ANY(ARRAY[
          'sync_connector_external_code_sessions_connector_slug',
          'sync_connector_oauth_device_sessions_connector_slug',
          'sync_connector_oauth_states_connector_slug',
          'sync_connectors_connector_slug',
          'sync_user_connectors_connector_slug',
          'sync_user_permission_grants_connector_slug'
        ])
          AND NOT "tgisinternal"
      `);
      assert.deepEqual(removedBridgeTriggers.rows, []);

      const removedBridgeFunctions = await client.query<{
        readonly name: string;
      }>(`
        SELECT "proname" AS "name"
        FROM "pg_proc"
        JOIN "pg_namespace"
          ON "pg_namespace"."oid" = "pg_proc"."pronamespace"
        WHERE "pg_namespace"."nspname" = current_schema()
          AND "proname" = ANY(ARRAY[
            'sync_connector_slug_from_connector_ref',
            'sync_connector_slug_from_connector_type',
            'sync_connector_slug_from_type'
          ])
      `);
      assert.deepEqual(removedBridgeFunctions.rows, []);

      const removedBridgeChecks = await client.query<{
        readonly name: string;
      }>(`
        SELECT "conname" AS "name"
        FROM "pg_constraint"
        WHERE "conname" = ANY(ARRAY[
          'chk_connector_external_code_sessions_slug_matches_type',
          'chk_connector_oauth_device_sessions_slug_matches_type',
          'chk_connector_oauth_states_slug_matches_type',
          'chk_connectors_connector_slug_matches_type',
          'chk_user_connectors_slug_matches_type',
          'chk_user_permission_grants_slug_matches_ref'
        ])
      `);
      assert.deepEqual(removedBridgeChecks.rows, []);

      const removedLegacyIndexes = await client.query<{
        readonly name: string;
      }>(`
        SELECT "indexname" AS "name"
        FROM "pg_indexes"
        WHERE "schemaname" = current_schema()
          AND "indexname" = ANY(ARRAY[
            'idx_connector_external_code_sessions_owner_status',
            'idx_connector_oauth_device_authorization_sessions_owner_status',
            'idx_connectors_org_user_type',
            'idx_user_connectors_unique',
            'uq_user_permission_grants_grant'
          ])
      `);
      assert.deepEqual(removedLegacyIndexes.rows, []);

      const finalIdentityChecks = await client.query<{
        readonly definition: string;
        readonly name: string;
      }>(`
        SELECT
          "conname" AS "name",
          pg_get_constraintdef("pg_constraint"."oid") AS "definition"
        FROM "pg_constraint"
        JOIN "pg_class" ON "pg_class"."oid" = "pg_constraint"."conrelid"
        JOIN "pg_namespace" ON "pg_namespace"."oid" = "pg_class"."relnamespace"
        WHERE "pg_namespace"."nspname" = current_schema()
          AND "conname" = ANY(ARRAY[
            'chk_connector_oauth_states_identity',
            'chk_connectors_identity'
          ])
        ORDER BY "conname"
      `);
      assert.deepEqual(
        finalIdentityChecks.rows.map((row) => {
          return row.name;
        }),
        ["chk_connector_oauth_states_identity", "chk_connectors_identity"],
      );
      assert.ok(
        finalIdentityChecks.rows.every((row) => {
          return (
            row.definition.includes("connector_slug") &&
            row.definition.includes("custom_connector_id") &&
            !row.definition.includes('"type"')
          );
        }),
      );

      const finalCanonicalIndexes = await client.query<{
        readonly definition: string;
        readonly name: string;
      }>(`
        SELECT
          "indexname" AS "name",
          "indexdef" AS "definition"
        FROM "pg_indexes"
        WHERE "schemaname" = current_schema()
          AND "indexname" = ANY(ARRAY[
            'idx_connector_external_code_sessions_owner_slug_status',
            'idx_connector_oauth_device_sessions_owner_slug_status',
            'idx_connectors_org_user_slug',
            'idx_user_connectors_unique_slug',
            'uq_user_permission_grants_slug_permission'
          ])
        ORDER BY "indexname"
      `);
      assert.deepEqual(
        finalCanonicalIndexes.rows.map((row) => {
          return row.name;
        }),
        expectedIndexes,
      );
      assert.ok(
        finalCanonicalIndexes.rows.every((row) => {
          return row.definition.includes("connector_slug");
        }),
      );

      const finalNullability = await client.query<{
        readonly isNullable: "NO" | "YES";
        readonly tableName: string;
      }>(`
        SELECT
          "table_name" AS "tableName",
          "is_nullable" AS "isNullable"
        FROM "information_schema"."columns"
        WHERE "table_schema" = current_schema()
          AND "column_name" = 'connector_slug'
          AND "table_name" = ANY(ARRAY[
            'connector_external_code_sessions',
            'connector_oauth_device_authorization_sessions',
            'connector_oauth_states',
            'connectors',
            'user_connectors',
            'user_permission_grants'
          ])
        ORDER BY "table_name"
      `);
      assert.deepEqual(finalNullability.rows, canonicalNullability.rows);

      const preservedBuiltInRows = await client.query<{
        readonly connectorSlug: string;
        readonly tableName: string;
      }>(
        `
          SELECT
            'connectors' AS "tableName",
            "connector_slug" AS "connectorSlug"
          FROM "connectors"
          WHERE "id" = $1
          UNION ALL
          SELECT
            'user_connectors',
            "connector_slug"
          FROM "user_connectors"
          WHERE "id" = $2
          UNION ALL
          SELECT
            'connector_oauth_states',
            "connector_slug"
          FROM "connector_oauth_states"
          WHERE "id" = $3
          UNION ALL
          SELECT
            'connector_oauth_device_authorization_sessions',
            "connector_slug"
          FROM "connector_oauth_device_authorization_sessions"
          WHERE "id" = $4
          UNION ALL
          SELECT
            'connector_external_code_sessions',
            "connector_slug"
          FROM "connector_external_code_sessions"
          WHERE "id" = $5
          UNION ALL
          SELECT
            'user_permission_grants',
            "connector_slug"
          FROM "user_permission_grants"
          WHERE "id" = $6
          ORDER BY "tableName"
        `,
        [
          connectorSlugCutoverInsertIds.connectors,
          connectorSlugCutoverInsertIds.user_connectors,
          connectorSlugCutoverInsertIds.connector_oauth_states,
          connectorSlugCutoverInsertIds.connector_oauth_device_authorization_sessions,
          connectorSlugCutoverInsertIds.connector_external_code_sessions,
          connectorSlugCutoverInsertIds.user_permission_grants,
        ],
      );
      assert.deepEqual(preservedBuiltInRows.rows, [
        {
          connectorSlug: "cutover-x",
          tableName: "connector_external_code_sessions",
        },
        {
          connectorSlug: "cutover-youtube",
          tableName: "connector_oauth_device_authorization_sessions",
        },
        {
          connectorSlug: "cutover-gmail",
          tableName: "connector_oauth_states",
        },
        {
          connectorSlug: "cutover-google-drive",
          tableName: "connectors",
        },
        {
          connectorSlug: "cutover-google-calendar",
          tableName: "user_connectors",
        },
        {
          connectorSlug: "cutover-slack",
          tableName: "user_permission_grants",
        },
      ]);

      const preservedCustomRows = await client.query<{
        readonly connectorSlug: string | null;
        readonly customConnectorId: string;
      }>(
        `
          SELECT
            "connector_slug" AS "connectorSlug",
            "custom_connector_id" AS "customConnectorId"
          FROM "connectors"
          WHERE "id" = $1
          UNION ALL
          SELECT
            "connector_slug",
            "custom_connector_id"
          FROM "connector_oauth_states"
          WHERE "id" = $2
        `,
        [
          CONNECTOR_SLUG_CUTOVER_CUSTOM_CONNECTION_ID,
          CONNECTOR_SLUG_CUTOVER_CUSTOM_OAUTH_STATE_ID,
        ],
      );
      assert.deepEqual(preservedCustomRows.rows, [
        {
          connectorSlug: null,
          customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
        },
        {
          connectorSlug: null,
          customConnectorId: CONNECTOR_SLUG_TEST_CUSTOM_CONNECTOR_ID,
        },
      ]);

      await validateFinalConnectorSlugWrites(client);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Connector slug cutover statements contract legacy identity storage and keep canonical/custom identities valid\n",
  );
}

async function validateInsightsConnectorSlugExpansion(): Promise<void> {
  console.log(
    "=== Phase 1.61: Validate insights connector slug expansion ===\n",
  );
  const previousMigration = 753;
  const targetMigration = 754;
  const targetMigrationTag = "0754_expand_insights_connector_slug";
  const successDb = "migration_insights_connector_slug_expansion_test";
  const rejectionDb =
    "migration_insights_connector_slug_expansion_rejection_test";
  const successDbUrl = createTestDbUrl(successDb);
  const rejectionDbUrl = createTestDbUrl(rejectionDb);
  const legacyData = {
    permissions: [
      {
        label: "repo-read",
        connectorType: "github",
        allowed: 3,
        denied: 0,
        agentNames: ["Research agent"],
        metadata: { retained: true },
      },
      {
        label: "channels:read",
        connectorSlug: "slack",
        allowed: 2,
        denied: 0,
        agentNames: ["Support agent"],
      },
      {
        label: "pages:read",
        connectorSlug: "notion",
        connectorType: "notion",
        allowed: 1,
        denied: 0,
        agentNames: ["Knowledge agent"],
      },
      {
        label: "unscoped",
        allowed: 0,
        denied: 1,
        agentNames: [],
      },
    ],
    unrelated: {
      nested: ["preserve", 42],
    },
  };
  const expandedData = {
    ...legacyData,
    permissions: [
      {
        ...legacyData.permissions[0],
        connectorSlug: "github",
      },
      legacyData.permissions[1],
      legacyData.permissions[2],
      legacyData.permissions[3],
    ],
  };

  await createDatabase(successDb);
  try {
    await runMigrationsUpTo(successDbUrl, previousMigration);
    const client = new Client({ connectionString: successDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "insights_daily" (
            "id",
            "org_id",
            "user_id",
            "date",
            "data",
            "updated_at"
          )
          VALUES (
            '00000000-0000-4000-8000-000000075301',
            'insights-slug-org',
            'insights-slug-user',
            '2026-07-30',
            $1::jsonb,
            '2026-07-30T00:00:00.000Z'
          )
        `,
        [JSON.stringify(legacyData)],
      );

      await applyMigrationsUpTo(client, targetMigration);

      const result = await client.query<{ readonly data: unknown }>(
        `
          SELECT "data"
          FROM "insights_daily"
          WHERE "id" = '00000000-0000-4000-8000-000000075301'
        `,
      );
      assert.deepEqual(result.rows[0]?.data, expandedData);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(successDb);
  }

  const compatibleData = {
    permissions: [
      {
        label: "repo-read",
        connectorType: "github",
        allowed: 1,
        denied: 0,
        agentNames: ["Research agent"],
      },
    ],
    marker: "must remain unchanged",
  };
  const conflictingData = {
    permissions: [
      {
        label: "channels:read",
        connectorSlug: "slack",
        connectorType: "github",
        allowed: 1,
        denied: 0,
        agentNames: ["Support agent"],
      },
    ],
  };

  await createDatabase(rejectionDb);
  try {
    await runMigrationsUpTo(rejectionDbUrl, previousMigration);
    const client = new Client({ connectionString: rejectionDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "insights_daily" (
            "id",
            "org_id",
            "user_id",
            "date",
            "data"
          )
          VALUES
            (
              '00000000-0000-4000-8000-000000075302',
              'insights-slug-org',
              'insights-slug-user',
              '2026-07-29',
              $1::jsonb
            ),
            (
              '00000000-0000-4000-8000-000000075303',
              'insights-slug-org',
              'insights-slug-user',
              '2026-07-30',
              $2::jsonb
            )
        `,
        [JSON.stringify(compatibleData), JSON.stringify(conflictingData)],
      );

      await assert.rejects(
        applyMigrationsUpTo(client, targetMigration),
        /conflicting connectorSlug and connectorType identities/,
      );

      const rows = await client.query<{
        readonly data: unknown;
        readonly id: string;
      }>(
        `
          SELECT "id", "data"
          FROM "insights_daily"
          WHERE "id" IN (
            '00000000-0000-4000-8000-000000075302',
            '00000000-0000-4000-8000-000000075303'
          )
          ORDER BY "id"
        `,
      );
      assert.deepEqual(rows.rows, [
        {
          id: "00000000-0000-4000-8000-000000075302",
          data: compatibleData,
        },
        {
          id: "00000000-0000-4000-8000-000000075303",
          data: conflictingData,
        },
      ]);

      const migrationRecord = await client.query<{
        readonly count: number;
      }>(
        `
          SELECT COUNT(*)::int AS "count"
          FROM "__drizzle_migrations"
          WHERE "hash" = $1
        `,
        [targetMigrationTag],
      );
      assert.equal(migrationRecord.rows[0]?.count, 0);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(rejectionDb);
  }

  console.log(
    "   ✅ Insights connector slug expansion preserves JSONB and rejects conflicts atomically\n",
  );
}

async function validateInsightsConnectorTypeCleanup(): Promise<void> {
  console.log("=== Phase 1.62: Validate insights connector type cleanup ===\n");
  const previousMigration = 768;
  const targetMigration = 769;
  const targetMigrationTag = "0769_remove_insights_connector_type";
  const successDb = "migration_insights_connector_type_cleanup_test";
  const rejectionDb =
    "migration_insights_connector_type_cleanup_rejection_test";
  const successDbUrl = createTestDbUrl(successDb);
  const rejectionDbUrl = createTestDbUrl(rejectionDb);
  const sourceData = {
    permissions: [
      {
        label: "repo-read",
        connectorType: "github",
        allowed: 3,
        denied: 0,
        agentNames: ["Research agent"],
        metadata: { retained: true },
      },
      {
        label: "channels:read",
        connectorSlug: "slack",
        allowed: 2,
        denied: 0,
        agentNames: ["Support agent"],
      },
      {
        label: "pages:read",
        connectorSlug: "notion",
        connectorType: "notion",
        allowed: 1,
        denied: 0,
        agentNames: ["Knowledge agent"],
      },
      {
        label: "unscoped",
        allowed: 0,
        denied: 1,
        agentNames: [],
      },
      {
        label: "malformed",
        connectorType: 42,
        allowed: 0,
        denied: 1,
        agentNames: [],
      },
      "preserve-non-object",
    ],
    unrelated: {
      nested: ["preserve", 42],
    },
  };
  const expectedData = {
    ...sourceData,
    permissions: [
      {
        label: "repo-read",
        connectorSlug: "github",
        allowed: 3,
        denied: 0,
        agentNames: ["Research agent"],
        metadata: { retained: true },
      },
      sourceData.permissions[1],
      {
        label: "pages:read",
        connectorSlug: "notion",
        allowed: 1,
        denied: 0,
        agentNames: ["Knowledge agent"],
      },
      sourceData.permissions[3],
      {
        label: "malformed",
        allowed: 0,
        denied: 1,
        agentNames: [],
      },
      sourceData.permissions[5],
    ],
  };
  const nonArrayData = {
    permissions: {
      connectorType: "github",
      marker: "preserve malformed container",
    },
    unrelated: true,
  };

  await createDatabase(successDb);
  try {
    await runMigrationsUpTo(successDbUrl, previousMigration);
    const client = new Client({ connectionString: successDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "insights_daily" (
            "id",
            "org_id",
            "user_id",
            "date",
            "data",
            "updated_at"
          )
          VALUES
            (
              '00000000-0000-4000-8000-000000076701',
              'insights-cleanup-org',
              'insights-cleanup-user',
              '2026-07-29',
              $1::jsonb,
              '2026-07-29T00:00:00.000Z'
            ),
            (
              '00000000-0000-4000-8000-000000076702',
              'insights-cleanup-org',
              'insights-cleanup-user',
              '2026-07-30',
              $2::jsonb,
              '2026-07-30T00:00:00.000Z'
            )
        `,
        [JSON.stringify(sourceData), JSON.stringify(nonArrayData)],
      );

      await applyMigrationsUpTo(client, targetMigration);

      const result = await client.query<{
        readonly data: unknown;
        readonly id: string;
      }>(
        `
          SELECT "id", "data"
          FROM "insights_daily"
          WHERE "id" IN (
            '00000000-0000-4000-8000-000000076701',
            '00000000-0000-4000-8000-000000076702'
          )
          ORDER BY "id"
        `,
      );
      assert.deepEqual(result.rows, [
        {
          id: "00000000-0000-4000-8000-000000076701",
          data: expectedData,
        },
        {
          id: "00000000-0000-4000-8000-000000076702",
          data: nonArrayData,
        },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(successDb);
  }

  const compatibleData = {
    permissions: [
      {
        label: "repo-read",
        connectorType: "github",
        allowed: 1,
        denied: 0,
        agentNames: ["Research agent"],
      },
    ],
    marker: "must remain unchanged",
  };
  const conflictingData = {
    permissions: [
      {
        label: "channels:read",
        connectorSlug: "slack",
        connectorType: "github",
        allowed: 1,
        denied: 0,
        agentNames: ["Support agent"],
      },
    ],
  };

  await createDatabase(rejectionDb);
  try {
    await runMigrationsUpTo(rejectionDbUrl, previousMigration);
    const client = new Client({ connectionString: rejectionDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "insights_daily" (
            "id",
            "org_id",
            "user_id",
            "date",
            "data"
          )
          VALUES
            (
              '00000000-0000-4000-8000-000000076703',
              'insights-cleanup-org',
              'insights-cleanup-user',
              '2026-07-29',
              $1::jsonb
            ),
            (
              '00000000-0000-4000-8000-000000076704',
              'insights-cleanup-org',
              'insights-cleanup-user',
              '2026-07-30',
              $2::jsonb
            )
        `,
        [JSON.stringify(compatibleData), JSON.stringify(conflictingData)],
      );

      await assert.rejects(
        applyMigrationsUpTo(client, targetMigration),
        /conflicting connectorSlug and connectorType identities/,
      );

      const rows = await client.query<{
        readonly data: unknown;
        readonly id: string;
      }>(
        `
          SELECT "id", "data"
          FROM "insights_daily"
          WHERE "id" IN (
            '00000000-0000-4000-8000-000000076703',
            '00000000-0000-4000-8000-000000076704'
          )
          ORDER BY "id"
        `,
      );
      assert.deepEqual(rows.rows, [
        {
          id: "00000000-0000-4000-8000-000000076703",
          data: compatibleData,
        },
        {
          id: "00000000-0000-4000-8000-000000076704",
          data: conflictingData,
        },
      ]);

      const migrationRecord = await client.query<{
        readonly count: number;
      }>(
        `
          SELECT COUNT(*)::int AS "count"
          FROM "__drizzle_migrations"
          WHERE "hash" = $1
        `,
        [targetMigrationTag],
      );
      assert.equal(migrationRecord.rows[0]?.count, 0);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(rejectionDb);
  }

  console.log(
    "   ✅ Insights connector type cleanup preserves JSONB and rejects conflicts atomically\n",
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

    const missingCols = dbCols.filter((c) => {
      return !snapshotCols.includes(c);
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

async function validateSlackChatThreadRouteBackfill(): Promise<void> {
  console.log(
    "=== Phase 1.75: Validate Slack chat thread route backfill ===\n",
  );
  const testDb = "migration_slack_chat_thread_route_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const connectionId = "50000000-0000-4000-8000-000000000001";
  const composeId = "50000000-0000-4000-8000-000000000002";
  const sessionId = "50000000-0000-4000-8000-000000000003";
  const resolvedSlotId = "50000000-0000-4000-8000-000000000004";
  const unresolvedSlotId = "50000000-0000-4000-8000-000000000005";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 631);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO "slack_org_installations" (
          "slack_workspace_id",
          "encrypted_bot_token",
          "bot_user_id"
        )
        VALUES ('route-backfill-workspace', 'encrypted-token', 'route-backfill-bot')
      `);
      await client.query(
        `
          INSERT INTO "slack_org_connections" (
            "id",
            "slack_user_id",
            "slack_workspace_id",
            "vm0_user_id"
          )
          VALUES ($1, 'route-backfill-slack-user', 'route-backfill-workspace', 'connection-owner')
        `,
        [connectionId],
      );
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'slot-owner', 'route-backfill-agent', 'route-backfill-org')
        `,
        [composeId],
      );
      await client.query(
        `
          INSERT INTO "agent_sessions" (
            "id",
            "user_id",
            "org_id",
            "agent_compose_id"
          )
          VALUES ($1, 'slot-owner', 'route-backfill-org', $2)
        `,
        [sessionId, composeId],
      );
      await client.query(
        `
          INSERT INTO "slack_org_thread_sessions" (
            "id",
            "connection_id",
            "slack_channel_id",
            "slack_thread_ts",
            "agent_session_id"
          )
          VALUES
            ($1, $3, 'resolved-channel', '1000.000001', $4),
            ($2, $3, 'unresolved-channel', '1000.000002', NULL)
        `,
        [resolvedSlotId, unresolvedSlotId, connectionId, sessionId],
      );

      await applyMigrationsUpTo(client, 633);

      const routes = await client.query<{
        backend: string;
        channel_id: string;
        chat_thread_id: string | null;
        connection_id: string;
        thread_ts: string;
        user_id: string;
      }>(`
        SELECT
          "backend",
          "channel_id",
          "chat_thread_id",
          "connection_id",
          "thread_ts",
          "user_id"
        FROM "slack_chat_thread_routes"
        ORDER BY "channel_id"
      `);
      assert.deepEqual(routes.rows, [
        {
          backend: "legacy",
          channel_id: "resolved-channel",
          chat_thread_id: null,
          connection_id: connectionId,
          thread_ts: "1000.000001",
          user_id: "slot-owner",
        },
      ]);
      console.log(
        "   ✅ Backfill writes only the resolvable slot owner and skips the unresolved slot\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateSlackLegacySchemaContraction(): Promise<void> {
  console.log("=== Phase 1.76: Validate legacy Slack schema contraction ===\n");
  const testDb = "migration_slack_legacy_schema_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);
  const connectionId = "51000000-0000-4000-8000-000000000001";
  const sessionId = "51000000-0000-4000-8000-000000000002";
  const routeId = "51000000-0000-4000-8000-000000000003";

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 693);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO "slack_org_installations" (
          "slack_workspace_id",
          "encrypted_bot_token",
          "bot_user_id"
        )
        VALUES (
          'legacy-contraction-workspace',
          'encrypted-token',
          'legacy-contraction-bot'
        )
      `);
      await client.query(
        `
          INSERT INTO "slack_org_connections" (
            "id",
            "slack_user_id",
            "slack_workspace_id",
            "vm0_user_id"
          )
          VALUES (
            $1,
            'legacy-contraction-slack-user',
            'legacy-contraction-workspace',
            'legacy-contraction-user'
          )
        `,
        [connectionId],
      );
      await client.query(
        `
          INSERT INTO "slack_org_thread_sessions" (
            "id",
            "connection_id",
            "slack_channel_id",
            "slack_thread_ts"
          )
          VALUES ($1, $2, 'legacy-channel', '1000.000001')
        `,
        [sessionId, connectionId],
      );
      await client.query(
        `
          INSERT INTO "slack_chat_thread_routes" (
            "id",
            "connection_id",
            "channel_id",
            "thread_ts",
            "user_id",
            "backend",
            "chat_thread_id",
            "legacy_cutover_event_id",
            "legacy_cutover_message_ts"
          )
          VALUES (
            $1,
            $2,
            'legacy-channel',
            '1000.000001',
            'legacy-contraction-user',
            'legacy',
            NULL,
            'legacy-cutover-event',
            '1000.000002'
          )
        `,
        [routeId, connectionId],
      );
      await client.query(
        `
          INSERT INTO "slack_chat_ingress" (
            "route_id",
            "event_id",
            "payload"
          )
          VALUES (
            $1,
            'legacy-retry-event',
            '{"event":{"ts":"1000.000001"}}'
          )
        `,
        [routeId],
      );
      await client.query(`
        INSERT INTO "user_feature_switches" (
          "org_id",
          "user_id",
          "switches"
        )
        VALUES (
          'legacy-contraction-org',
          'legacy-contraction-user',
          '{
            "canonicalSlackIngress": false,
            "canonicalSlackWebVisibility": true,
            "canonicalSlackAssets": false,
            "unrelatedSwitch": true
          }'::jsonb
        )
      `);

      await applyMigrationsUpTo(client, 695);

      const [legacyState, routeColumns, switches] = await Promise.all([
        client.query<{
          ingress_exists: boolean;
          legacy_classifier: string | null;
          legacy_session_table: string | null;
          route_canonicalizer: string | null;
          route_exists: boolean;
        }>(
          `
            SELECT
              EXISTS (
                SELECT 1
                FROM "slack_chat_ingress"
                WHERE "event_id" = 'legacy-retry-event'
              ) AS "ingress_exists",
              to_regprocedure(
                'classify_legacy_slack_cutover_ingress()'
              )::text AS "legacy_classifier",
              to_regclass(
                'public.slack_org_thread_sessions'
              )::text AS "legacy_session_table",
              to_regprocedure(
                'canonicalize_slack_chat_thread_route()'
              )::text AS "route_canonicalizer",
              EXISTS (
                SELECT 1
                FROM "slack_chat_thread_routes"
                WHERE "id" = $1
              ) AS "route_exists"
          `,
          [routeId],
        ),
        client.query<{ column_name: string; is_nullable: "NO" | "YES" }>(`
          SELECT "column_name", "is_nullable"
          FROM "information_schema"."columns"
          WHERE "table_schema" = 'public'
            AND "table_name" = 'slack_chat_thread_routes'
          ORDER BY "ordinal_position"
        `),
        client.query<{ switches: Record<string, boolean> }>(`
          SELECT "switches"
          FROM "user_feature_switches"
          WHERE "org_id" = 'legacy-contraction-org'
            AND "user_id" = 'legacy-contraction-user'
        `),
      ]);

      assert.deepEqual(legacyState.rows, [
        {
          ingress_exists: false,
          legacy_classifier: null,
          legacy_session_table: null,
          route_canonicalizer: null,
          route_exists: false,
        },
      ]);
      assert.deepEqual(routeColumns.rows, [
        { column_name: "id", is_nullable: "NO" },
        { column_name: "connection_id", is_nullable: "NO" },
        { column_name: "channel_id", is_nullable: "NO" },
        { column_name: "thread_ts", is_nullable: "NO" },
        { column_name: "user_id", is_nullable: "NO" },
        { column_name: "chat_thread_id", is_nullable: "NO" },
        { column_name: "created_at", is_nullable: "NO" },
      ]);
      assert.deepEqual(switches.rows, [
        {
          switches: {
            unrelatedSwitch: true,
          },
        },
      ]);
      console.log(
        "   ✅ Legacy Slack rows, schema, triggers, and feature overrides are removed\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateTeamsThreadSessionContraction(): Promise<void> {
  console.log("=== Validate legacy Teams thread session contraction ===\n");
  const testDb = "migration_teams_thread_session_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 725);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const beforeDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.teams_org_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(beforeDrop.rows, [
        { legacy_session_table: "teams_org_thread_sessions" },
      ]);

      await applyMigrationsUpTo(client, 726);

      const afterDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.teams_org_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(afterDrop.rows, [{ legacy_session_table: null }]);
      console.log("   ✅ Legacy Teams thread session table is removed\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateTelegramThreadSessionContraction(): Promise<void> {
  console.log("=== Validate legacy Telegram thread session contraction ===\n");
  const testDb = "migration_telegram_thread_session_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 740);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const beforeDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.telegram_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(beforeDrop.rows, [
        { legacy_session_table: "telegram_thread_sessions" },
      ]);

      await applyMigrationsUpTo(client, 741);

      const afterDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.telegram_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(afterDrop.rows, [{ legacy_session_table: null }]);
      console.log("   ✅ Legacy Telegram thread session table is removed\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateAgentPhoneThreadSessionContraction(): Promise<void> {
  console.log(
    "=== Validate legacy AgentPhone thread session contraction ===\n",
  );
  const testDb = "migration_agentphone_thread_session_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 757);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const beforeDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.agentphone_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(beforeDrop.rows, [
        { legacy_session_table: "agentphone_thread_sessions" },
      ]);

      await applyMigrationsUpTo(client, 758);

      const afterDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.agentphone_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(afterDrop.rows, [{ legacy_session_table: null }]);
      console.log("   ✅ Legacy AgentPhone thread session table is removed\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateFeishuThreadSessionContraction(): Promise<void> {
  console.log("=== Validate legacy Feishu thread session contraction ===\n");
  const testDb = "migration_feishu_thread_session_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 758);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const beforeDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.feishu_org_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(beforeDrop.rows, [
        { legacy_session_table: "feishu_org_thread_sessions" },
      ]);

      await applyMigrationsUpTo(client, 759);

      const afterDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.feishu_org_thread_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(afterDrop.rows, [{ legacy_session_table: null }]);
      console.log("   ✅ Legacy Feishu thread session table is removed\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateChatDisplayContextBackfill(): Promise<void> {
  console.log("=== Validate chat display context backfill ===\n");
  const testDb = "migration_chat_display_context_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const agentComposeId = "00000000-0000-4000-8000-000000076301";
  const threadId = "00000000-0000-4000-8000-000000076302";
  const slackContextId = "00000000-0000-4000-8000-000000076310";
  const feishuContextId = "00000000-0000-4000-8000-000000076320";
  const deploymentSlackContextId = "00000000-0000-4000-8000-000000076340";
  const deploymentFeishuContextId = "00000000-0000-4000-8000-000000076350";

  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0763_add_chat_display_contexts.sql"),
    "utf8",
  );
  assert.doesNotMatch(migrationSql, /\bLOCK TABLE\b/u);
  const dropMigrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0765_drop_chat_event_display_links.sql"),
    "utf8",
  );
  assert.doesNotMatch(dropMigrationSql, /\bLOCK TABLE\b/u);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 762);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'display-context-test-user',
            'display-context-test',
            'display-context-test-org'
          )
        `,
        [agentComposeId],
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
            'display-context-test-user',
            $2,
            'display context test'
          )
        `,
        [threadId, agentComposeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "revokes_message_id",
            "slack_message_permalink",
            "feishu_chat_open_url",
            "created_at"
          )
          VALUES
            (
              $2,
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Slack carrier"}]}'::jsonb,
              NULL,
              'https://example.slack.com/archives/C1/p1',
              NULL,
              '2026-07-23 00:00:00'
            ),
            (
              '00000000-0000-4000-8000-000000076311',
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Slack claim"}]}'::jsonb,
              $2,
              NULL,
              NULL,
              '2026-07-23 00:00:01'
            ),
            (
              '00000000-0000-4000-8000-000000076312',
              $1,
              'input.rejected',
              '{"version":1,"parts":[{"type":"text","text":"Slack rejection"}]}'::jsonb,
              '00000000-0000-4000-8000-000000076311',
              NULL,
              NULL,
              '2026-07-23 00:00:02'
            ),
            (
              $3,
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Feishu carrier"}]}'::jsonb,
              NULL,
              NULL,
              'https://applink.feishu.cn/client/chat/open?openChatId=oc_test',
              '2026-07-24 00:00:00'
            ),
            (
              '00000000-0000-4000-8000-000000076321',
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Feishu claim"}]}'::jsonb,
              $3,
              NULL,
              NULL,
              '2026-07-24 00:00:01'
            ),
            (
              '00000000-0000-4000-8000-000000076330',
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"No permalink"}]}'::jsonb,
              NULL,
              NULL,
              NULL,
              '2026-07-25 00:00:00'
            )
        `,
        [threadId, slackContextId, feishuContextId],
      );

      await applyMigrationsUpTo(client, 763);

      const slackContexts = await client.query<{
        chatThreadId: string;
        id: string;
        messagePermalink: string;
      }>(`
        SELECT
          "id",
          "chat_thread_id" AS "chatThreadId",
          "message_permalink" AS "messagePermalink"
        FROM "chat_slack_context"
        ORDER BY "id"
      `);
      assert.deepEqual(slackContexts.rows, [
        {
          id: slackContextId,
          chatThreadId: threadId,
          messagePermalink: "https://example.slack.com/archives/C1/p1",
        },
      ]);

      const feishuContexts = await client.query<{
        chatOpenUrl: string;
        chatThreadId: string;
        id: string;
      }>(`
        SELECT
          "id",
          "chat_thread_id" AS "chatThreadId",
          "chat_open_url" AS "chatOpenUrl"
        FROM "chat_feishu_context"
        ORDER BY "id"
      `);
      assert.deepEqual(feishuContexts.rows, [
        {
          id: feishuContextId,
          chatThreadId: threadId,
          chatOpenUrl:
            "https://applink.feishu.cn/client/chat/open?openChatId=oc_test",
        },
      ]);

      const pointers = await client.query<{
        contextId: string | null;
        contextType: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "chat_thread_id" = $1
          ORDER BY "id"
        `,
        [threadId],
      );
      assert.deepEqual(pointers.rows, [
        {
          id: slackContextId,
          contextType: "slack",
          contextId: slackContextId,
        },
        {
          id: "00000000-0000-4000-8000-000000076311",
          contextType: "slack",
          contextId: slackContextId,
        },
        {
          id: "00000000-0000-4000-8000-000000076312",
          contextType: "slack",
          contextId: slackContextId,
        },
        {
          id: feishuContextId,
          contextType: "feishu",
          contextId: feishuContextId,
        },
        {
          id: "00000000-0000-4000-8000-000000076321",
          contextType: "feishu",
          contextId: feishuContextId,
        },
        {
          id: "00000000-0000-4000-8000-000000076330",
          contextType: null,
          contextId: null,
        },
      ]);

      await expectDatabaseError(client, {
        code: "23502",
        messageIncludes: "message_permalink",
        query: `
          INSERT INTO "chat_slack_context" (
            "chat_thread_id",
            "message_permalink"
          )
          VALUES ($1, NULL)
        `,
        values: [threadId],
      });
      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `
          UPDATE "chat_events"
          SET "context_id" = NULL
          WHERE "id" = $1
        `,
        rowId: slackContextId,
      });

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "revokes_message_id",
            "slack_message_permalink",
            "feishu_chat_open_url",
            "created_at"
          )
          VALUES
            (
              $2,
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Deployment Slack carrier"}]}'::jsonb,
              NULL,
              'https://example.slack.com/archives/C2/p2',
              NULL,
              '2026-07-30 12:00:00'
            ),
            (
              '00000000-0000-4000-8000-000000076341',
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Deployment Slack claim"}]}'::jsonb,
              $2,
              NULL,
              NULL,
              '2026-07-30 12:00:01'
            ),
            (
              $3,
              $1,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Deployment Feishu carrier"}]}'::jsonb,
              NULL,
              NULL,
              'https://applink.feishu.cn/client/chat/open?openChatId=oc_deploy',
              '2026-07-30 12:00:02'
            ),
            (
              '00000000-0000-4000-8000-000000076351',
              $1,
              'input.rejected',
              '{"version":1,"parts":[{"type":"text","text":"Deployment Feishu rejection"}]}'::jsonb,
              $3,
              NULL,
              NULL,
              '2026-07-30 12:00:03'
            )
        `,
        [threadId, deploymentSlackContextId, deploymentFeishuContextId],
      );

      const deploymentWindowPointers = await client.query<{
        contextId: string | null;
        contextType: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN (
            $1,
            '00000000-0000-4000-8000-000000076341',
            $2,
            '00000000-0000-4000-8000-000000076351'
          )
          ORDER BY "id"
        `,
        [deploymentSlackContextId, deploymentFeishuContextId],
      );
      assert.deepEqual(deploymentWindowPointers.rows, [
        {
          id: deploymentSlackContextId,
          contextType: null,
          contextId: null,
        },
        {
          id: "00000000-0000-4000-8000-000000076341",
          contextType: null,
          contextId: null,
        },
        {
          id: deploymentFeishuContextId,
          contextType: null,
          contextId: null,
        },
        {
          id: "00000000-0000-4000-8000-000000076351",
          contextType: null,
          contextId: null,
        },
      ]);

      await applyMigrationsUpTo(client, 765);

      const caughtUpContexts = await client.query<{
        contextId: string;
        contextType: string;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN (
            $1,
            '00000000-0000-4000-8000-000000076341',
            $2,
            '00000000-0000-4000-8000-000000076351'
          )
          ORDER BY "id"
        `,
        [deploymentSlackContextId, deploymentFeishuContextId],
      );
      assert.deepEqual(caughtUpContexts.rows, [
        {
          id: deploymentSlackContextId,
          contextType: "slack",
          contextId: deploymentSlackContextId,
        },
        {
          id: "00000000-0000-4000-8000-000000076341",
          contextType: "slack",
          contextId: deploymentSlackContextId,
        },
        {
          id: deploymentFeishuContextId,
          contextType: "feishu",
          contextId: deploymentFeishuContextId,
        },
        {
          id: "00000000-0000-4000-8000-000000076351",
          contextType: "feishu",
          contextId: deploymentFeishuContextId,
        },
      ]);

      const caughtUpDisplayContexts = await client.query<{
        contextType: string;
        displayUrl: string;
        id: string;
      }>(
        `
          SELECT
            "id",
            'slack' AS "contextType",
            "message_permalink" AS "displayUrl"
          FROM "chat_slack_context"
          WHERE "id" = $1
          UNION ALL
          SELECT
            "id",
            'feishu' AS "contextType",
            "chat_open_url" AS "displayUrl"
          FROM "chat_feishu_context"
          WHERE "id" = $2
          ORDER BY "contextType"
        `,
        [deploymentSlackContextId, deploymentFeishuContextId],
      );
      assert.deepEqual(caughtUpDisplayContexts.rows, [
        {
          id: deploymentFeishuContextId,
          contextType: "feishu",
          displayUrl:
            "https://applink.feishu.cn/client/chat/open?openChatId=oc_deploy",
        },
        {
          id: deploymentSlackContextId,
          contextType: "slack",
          displayUrl: "https://example.slack.com/archives/C2/p2",
        },
      ]);

      const removedDisplayColumns = await client.query<{ columnName: string }>(`
        SELECT "column_name" AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_events'
          AND column_name IN (
            'slack_message_permalink',
            'feishu_chat_open_url'
          )
        ORDER BY "column_name"
      `);
      assert.deepEqual(removedDisplayColumns.rows, []);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `
          UPDATE "chat_events"
          SET "context_id" = NULL
          WHERE "id" = $1
        `,
        rowId: deploymentSlackContextId,
      });

      await client.query(`DELETE FROM "chat_threads" WHERE "id" = $1`, [
        threadId,
      ]);
      const remainingContexts = await client.query<{ count: string }>(`
        SELECT count(*)::text AS "count"
        FROM (
          SELECT "id" FROM "chat_slack_context"
          UNION ALL
          SELECT "id" FROM "chat_feishu_context"
        ) AS "contexts"
      `);
      assert.deepEqual(remainingContexts.rows, [{ count: "0" }]);

      console.log(
        "   ✅ Slack and Feishu links backfill through revoke chains without table locks",
      );
      console.log(
        "   ✅ Null Slack permalinks create no context and context rows cascade with threads\n",
      );
      console.log(
        "   ✅ Deployment-window links are caught up before legacy display columns are removed\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateChatAutomationContextBackfill(): Promise<void> {
  console.log("=== Validate chat automation context backfill ===\n");
  const testDb = "migration_chat_automation_context_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const agentComposeId = "00000000-0000-4000-8000-000000076701";
  const threadId = "00000000-0000-4000-8000-000000076702";
  const automationId = "00000000-0000-4000-8000-000000076703";
  const contextId = "00000000-0000-4000-8000-000000076710";
  const claimedEventId = "00000000-0000-4000-8000-000000076711";
  const deploymentAutomationId = "00000000-0000-4000-8000-000000076730";
  const deploymentContextId = "00000000-0000-4000-8000-000000076731";
  const deploymentClaimedEventId = "00000000-0000-4000-8000-000000076732";
  const planAutomationId = "00000000-0000-4000-8000-000000076720";
  const planContextId = "00000000-0000-4000-8000-000000076721";
  const triggerBrief =
    "GitHub issue #24111 updated (GitHub webhook delivery exact-0767).";
  const deploymentTriggerBrief =
    "Deployment-window GitHub delivery exact-trigger-brief-0772.";

  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0767_add_chat_automation_context.sql"),
    "utf8",
  );
  assert.doesNotMatch(migrationSql, /\bLOCK TABLE\b/u);
  const dropMigrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0772_drop_chat_event_automation_context.sql"),
    "utf8",
  );
  assert.doesNotMatch(dropMigrationSql, /\bLOCK TABLE\b/u);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 766);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'automation-context-test-user',
            'automation-context-test',
            'automation-context-test-org'
          )
        `,
        [agentComposeId],
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
            'automation-context-test-user',
            $2,
            'automation context test'
          )
        `,
        [threadId, agentComposeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "automation_id",
            "trigger_source",
            "trigger_brief",
            "created_at"
          )
          VALUES (
            $2,
            $1,
            'input.automation',
            $3,
            'workflow-event',
            $4,
            '2026-07-30 00:00:00'
          )
        `,
        [threadId, contextId, automationId, triggerBrief],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "run_id",
            "revokes_message_id",
            "created_at"
          )
          VALUES (
            $2,
            $1,
            'input.prompt',
            '{"version":1,"parts":[{"type":"text","text":"Claimed automation"}]}'::jsonb,
            '00000000-0000-4000-8000-000000076712',
            $3,
            '2026-07-30 00:00:01'
          )
        `,
        [threadId, claimedEventId, contextId],
      );

      await applyMigrationsUpTo(client, 767);

      const contexts = await client.query<{
        automationId: string;
        chatThreadId: string;
        id: string;
        triggerBrief: string | null;
      }>(`
        SELECT
          "id",
          "chat_thread_id" AS "chatThreadId",
          "automation_id" AS "automationId",
          "trigger_brief" AS "triggerBrief"
        FROM "chat_automation_context"
        ORDER BY "id"
      `);
      assert.deepEqual(contexts.rows, [
        {
          id: contextId,
          chatThreadId: threadId,
          automationId,
          triggerBrief,
        },
      ]);

      const pointers = await client.query<{
        contextId: string | null;
        contextType: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [contextId, claimedEventId],
      );
      assert.deepEqual(pointers.rows, [
        {
          id: contextId,
          contextType: "automation",
          contextId,
        },
        {
          id: claimedEventId,
          contextType: "automation",
          contextId,
        },
      ]);

      const foreignKeys = await client.query<{
        columnName: string;
        deleteRule: string;
        referencedTable: string;
      }>(`
        SELECT
          "kcu"."column_name" AS "columnName",
          "rc"."delete_rule" AS "deleteRule",
          "ccu"."table_name" AS "referencedTable"
        FROM "information_schema"."table_constraints" AS "tc"
        INNER JOIN "information_schema"."key_column_usage" AS "kcu"
          ON "tc"."constraint_name" = "kcu"."constraint_name"
          AND "tc"."constraint_schema" = "kcu"."constraint_schema"
        INNER JOIN "information_schema"."referential_constraints" AS "rc"
          ON "tc"."constraint_name" = "rc"."constraint_name"
          AND "tc"."constraint_schema" = "rc"."constraint_schema"
        INNER JOIN "information_schema"."constraint_column_usage" AS "ccu"
          ON "rc"."unique_constraint_name" = "ccu"."constraint_name"
          AND "rc"."unique_constraint_schema" = "ccu"."constraint_schema"
        WHERE "tc"."table_schema" = 'public'
          AND "tc"."table_name" = 'chat_automation_context'
          AND "tc"."constraint_type" = 'FOREIGN KEY'
        ORDER BY "kcu"."column_name"
      `);
      assert.deepEqual(foreignKeys.rows, [
        {
          columnName: "chat_thread_id",
          deleteRule: "CASCADE",
          referencedTable: "chat_threads",
        },
      ]);

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "automation_id",
            "trigger_source",
            "trigger_brief",
            "created_at"
          )
          VALUES (
            $2,
            $1,
            'input.automation',
            $3,
            'workflow-event',
            $4,
            '2026-07-30 12:00:00'
          )
        `,
        [
          threadId,
          deploymentContextId,
          deploymentAutomationId,
          deploymentTriggerBrief,
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "user_message",
            "run_id",
            "revokes_event_id",
            "created_at"
          )
          VALUES (
            $2,
            $1,
            'input.prompt',
            '{"version":1,"parts":[{"type":"text","text":"Deployment-window claim"}]}'::jsonb,
            '00000000-0000-4000-8000-000000076733',
            $3,
            '2026-07-30 12:00:01'
          )
        `,
        [threadId, deploymentClaimedEventId, deploymentContextId],
      );

      const deploymentWindowPointers = await client.query<{
        contextId: string | null;
        contextType: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [deploymentContextId, deploymentClaimedEventId],
      );
      assert.deepEqual(deploymentWindowPointers.rows, [
        {
          id: deploymentContextId,
          contextType: null,
          contextId: null,
        },
        {
          id: deploymentClaimedEventId,
          contextType: null,
          contextId: null,
        },
      ]);

      await applyMigrationsUpTo(client, 772);

      const caughtUpContext = await client.query<{
        automationId: string;
        chatThreadId: string;
        id: string;
        triggerBrief: string | null;
      }>(
        `
          SELECT
            "id",
            "chat_thread_id" AS "chatThreadId",
            "automation_id" AS "automationId",
            "trigger_brief" AS "triggerBrief"
          FROM "chat_automation_context"
          WHERE "id" = $1
        `,
        [deploymentContextId],
      );
      assert.deepEqual(caughtUpContext.rows, [
        {
          id: deploymentContextId,
          chatThreadId: threadId,
          automationId: deploymentAutomationId,
          triggerBrief: deploymentTriggerBrief,
        },
      ]);

      const caughtUpPointers = await client.query<{
        contextId: string;
        contextType: string;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"
        `,
        [deploymentContextId, deploymentClaimedEventId],
      );
      assert.deepEqual(caughtUpPointers.rows, [
        {
          id: deploymentContextId,
          contextType: "automation",
          contextId: deploymentContextId,
        },
        {
          id: deploymentClaimedEventId,
          contextType: "automation",
          contextId: deploymentContextId,
        },
      ]);

      const removedAutomationColumns = await client.query<{
        columnName: string;
      }>(`
        SELECT "column_name" AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_events'
          AND column_name IN ('automation_id', 'trigger_brief')
        ORDER BY "column_name"
      `);
      assert.deepEqual(removedAutomationColumns.rows, []);

      const automationIndexes = await client.query<{ indexName: string }>(`
        SELECT "indexname" AS "indexName"
        FROM "pg_indexes"
        WHERE "schemaname" = 'public'
          AND "indexname" IN (
            'chat_events_input_automation_idx',
            'chat_events_input_automation_context_idx',
            'chat_automation_context_automation_id_idx'
          )
        ORDER BY "indexname"
      `);
      assert.deepEqual(automationIndexes.rows, [
        { indexName: "chat_automation_context_automation_id_idx" },
        { indexName: "chat_events_input_automation_context_idx" },
      ]);

      await client.query(
        `
          INSERT INTO "chat_automation_context" (
            "id",
            "chat_thread_id",
            "automation_id",
            "trigger_brief"
          )
          VALUES ($1, $2, $3, 'execution plan target')
        `,
        [planContextId, threadId, planAutomationId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "context_type",
            "context_id",
            "trigger_source"
          )
          VALUES (
            '00000000-0000-4000-8000-000000076722',
            $1,
            'input.automation',
            'automation',
            $2,
            'workflow-event'
          )
        `,
        [threadId, planContextId],
      );
      await client.query(
        `
          WITH "contexts" AS (
            INSERT INTO "chat_automation_context" (
              "id",
              "chat_thread_id",
              "automation_id",
              "trigger_brief"
            )
            SELECT
              gen_random_uuid(),
              $1,
              gen_random_uuid(),
              'execution plan filler'
            FROM generate_series(1, 2000)
            RETURNING "id"
          )
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "event_type",
            "context_type",
            "context_id",
            "trigger_source"
          )
          SELECT
            gen_random_uuid(),
            $1,
            'input.automation',
            'automation',
            "id",
            'workflow-event'
          FROM "contexts"
        `,
        [threadId],
      );
      await client.query(`ANALYZE "chat_automation_context", "chat_events"`);

      const explanation = await client.query<{ "QUERY PLAN": unknown }>(
        `
          EXPLAIN (ANALYZE, FORMAT JSON)
          SELECT "event"."id"
          FROM "chat_automation_context" AS "context"
          INNER JOIN "chat_events" AS "event"
            ON "event"."context_type" = 'automation'
            AND "event"."context_id" = "context"."id"
          WHERE "context"."automation_id" = $1
            AND "event"."event_type" = 'input.automation'
            AND "event"."run_id" IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_events" AS "revoker"
              WHERE "revoker"."revokes_event_id" = "event"."id"
            )
          LIMIT 1
        `,
        [planAutomationId],
      );
      function collectIndexNames(value: unknown): readonly string[] {
        if (Array.isArray(value)) {
          return value.flatMap((item) => {
            return collectIndexNames(item);
          });
        }
        if (typeof value !== "object" || value === null) {
          return [];
        }
        const record = value as Record<string, unknown>;
        return [
          ...(typeof record["Index Name"] === "string"
            ? [record["Index Name"]]
            : []),
          ...Object.values(record).flatMap((item) => {
            return collectIndexNames(item);
          }),
        ];
      }
      const indexNames = collectIndexNames(explanation.rows[0]?.["QUERY PLAN"]);
      assert.ok(
        indexNames.includes("chat_automation_context_automation_id_idx"),
        `Expected automation context lookup index in plan, got ${indexNames.join(", ")}`,
      );
      assert.ok(
        indexNames.includes("chat_events_input_automation_context_idx"),
        `Expected chat event context partial index in plan, got ${indexNames.join(", ")}`,
      );

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `
          UPDATE "chat_events"
          SET "context_id" = NULL
          WHERE "id" = $1
        `,
        rowId: contextId,
      });

      await client.query(`DELETE FROM "chat_threads" WHERE "id" = $1`, [
        threadId,
      ]);
      const remainingContexts = await client.query<{ count: string }>(`
        SELECT count(*)::text AS "count"
        FROM "chat_automation_context"
      `);
      assert.deepEqual(remainingContexts.rows, [{ count: "0" }]);

      console.log(
        "   ✅ Automation identity backfills through revoke chains without table locks",
      );
      console.log(
        "   ✅ Automation ids have no FK and context rows cascade only with threads",
      );
      console.log(
        "   ✅ Coalescing plan uses both automation context indexes\n",
      );
      console.log(
        "   ✅ Deployment-window automation rows are caught up before legacy columns and index are removed\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateChatGoalContextBackfill(): Promise<void> {
  console.log("=== Validate chat goal context backfill ===\n");
  const testDb = "migration_chat_goal_context_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);
  const agentComposeId = "00000000-0000-4000-8000-000000077601";
  const threadId = "00000000-0000-4000-8000-000000077602";
  const goalId = "00000000-0000-4000-8000-000000077603";
  const contextId = "00000000-0000-4000-8000-000000077610";
  const claimedEventId = "00000000-0000-4000-8000-000000077611";
  const rejectedEventId = "00000000-0000-4000-8000-000000077612";
  const runId = "00000000-0000-4000-8000-000000077613";
  const catchupContextId = "00000000-0000-4000-8000-000000077620";
  const catchupClaimedEventId = "00000000-0000-4000-8000-000000077621";
  const catchupRejectedEventId = "00000000-0000-4000-8000-000000077622";
  const catchupRunId = "00000000-0000-4000-8000-000000077623";
  const objectiveBrief = "Preserve one objective snapshot across the chain";
  const catchupObjectiveBrief =
    "Catch up one objective snapshot before dropping the column";

  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0776_add_chat_goal_context.sql"),
    "utf8",
  );
  const contractionSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0777_drop_chat_event_goal_snapshot.sql"),
    "utf8",
  );
  assert.doesNotMatch(migrationSql, /\bLOCK TABLE\b/u);
  assert.match(migrationSql, /\brevokes_event_id\b/u);
  assert.doesNotMatch(migrationSql, /\brevokes_message_id\b/u);
  assert.doesNotMatch(contractionSql, /\bLOCK TABLE\b/u);
  assert.match(contractionSql, /\brevokes_event_id\b/u);
  assert.doesNotMatch(contractionSql, /\brevokes_message_id\b/u);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 775);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES (
            $1,
            'goal-context-test-user',
            'goal-context-test',
            'goal-context-test-org'
          )
        `,
        [agentComposeId],
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
            'goal-context-test-user',
            $2,
            'goal context test'
          )
        `,
        [threadId, agentComposeId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "event_type",
            "user_message",
            "error",
            "goal_snapshot",
            "revokes_event_id",
            "seq_id",
            "created_at"
          )
          VALUES
            (
              $2,
              $1,
              NULL,
              $5,
              'input.goal',
              NULL,
              NULL,
              jsonb_build_object('objectiveBrief', $6::text),
              NULL,
              1,
              '2026-07-31 00:00:00'
            ),
            (
              $3,
              $1,
              $7,
              $5,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Claimed goal"}]}'::jsonb,
              NULL,
              jsonb_build_object('objectiveBrief', $6::text),
              $2,
              2,
              '2026-07-31 00:00:01'
            ),
            (
              $4,
              $1,
              NULL,
              $5,
              'input.rejected',
              '{"version":1,"parts":[{"type":"text","text":"Rejected goal"}]}'::jsonb,
              'Goal run rejected',
              jsonb_build_object('objectiveBrief', $6::text),
              $3,
              3,
              '2026-07-31 00:00:02'
            )
        `,
        [
          threadId,
          contextId,
          claimedEventId,
          rejectedEventId,
          goalId,
          objectiveBrief,
          runId,
        ],
      );

      await applyMigrationsUpTo(client, 776);

      const contexts = await client.query<{
        chatThreadId: string;
        id: string;
        objectiveBrief: string;
      }>(`
        SELECT
          "id",
          "chat_thread_id" AS "chatThreadId",
          "objective_brief" AS "objectiveBrief"
        FROM "chat_goal_context"
        ORDER BY "id"
      `);
      assert.deepEqual(contexts.rows, [
        {
          id: contextId,
          chatThreadId: threadId,
          objectiveBrief,
        },
      ]);

      const pointers = await client.query<{
        contextId: string | null;
        contextType: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2, $3)
          ORDER BY "seq_id"
        `,
        [contextId, claimedEventId, rejectedEventId],
      );
      assert.deepEqual(pointers.rows, [
        { id: contextId, contextType: "goal", contextId },
        { id: claimedEventId, contextType: "goal", contextId },
        { id: rejectedEventId, contextType: "goal", contextId },
      ]);

      const foreignKeys = await client.query<{
        columnName: string;
        deleteRule: string;
        referencedTable: string;
      }>(`
        SELECT
          "kcu"."column_name" AS "columnName",
          "rc"."delete_rule" AS "deleteRule",
          "ccu"."table_name" AS "referencedTable"
        FROM "information_schema"."table_constraints" AS "tc"
        INNER JOIN "information_schema"."key_column_usage" AS "kcu"
          ON "tc"."constraint_name" = "kcu"."constraint_name"
          AND "tc"."constraint_schema" = "kcu"."constraint_schema"
        INNER JOIN "information_schema"."referential_constraints" AS "rc"
          ON "tc"."constraint_name" = "rc"."constraint_name"
          AND "tc"."constraint_schema" = "rc"."constraint_schema"
        INNER JOIN "information_schema"."constraint_column_usage" AS "ccu"
          ON "rc"."unique_constraint_name" = "ccu"."constraint_name"
          AND "rc"."unique_constraint_schema" = "ccu"."constraint_schema"
        WHERE "tc"."table_schema" = 'public'
          AND "tc"."table_name" = 'chat_goal_context'
          AND "tc"."constraint_type" = 'FOREIGN KEY'
        ORDER BY "kcu"."column_name"
      `);
      assert.deepEqual(foreignKeys.rows, [
        {
          columnName: "chat_thread_id",
          deleteRule: "CASCADE",
          referencedTable: "chat_threads",
        },
      ]);

      const indexes = await client.query<{ indexName: string }>(`
        SELECT "indexname" AS "indexName"
        FROM "pg_indexes"
        WHERE "schemaname" = 'public'
          AND "tablename" = 'chat_goal_context'
        ORDER BY "indexname"
      `);
      assert.deepEqual(indexes.rows, [{ indexName: "chat_goal_context_pkey" }]);

      await expectDatabaseError(client, {
        code: "23502",
        messageIncludes: "objective_brief",
        query: `
          INSERT INTO "chat_goal_context" (
            "chat_thread_id",
            "objective_brief"
          )
          VALUES ($1, NULL)
        `,
        values: [threadId],
      });
      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `
          UPDATE "chat_events"
          SET "context_id" = NULL
          WHERE "id" = $1
        `,
        rowId: contextId,
      });

      await client.query(
        `
          INSERT INTO "chat_events" (
            "id",
            "chat_thread_id",
            "run_id",
            "run_group_id",
            "event_type",
            "user_message",
            "error",
            "goal_snapshot",
            "revokes_event_id",
            "seq_id",
            "created_at"
          )
          VALUES
            (
              $2,
              $1,
              NULL,
              $5,
              'input.goal',
              NULL,
              NULL,
              jsonb_build_object('objectiveBrief', $6::text),
              NULL,
              4,
              '2026-07-31 00:00:03'
            ),
            (
              $3,
              $1,
              $7,
              $5,
              'input.prompt',
              '{"version":1,"parts":[{"type":"text","text":"Catch-up claimed goal"}]}'::jsonb,
              NULL,
              jsonb_build_object('objectiveBrief', $6::text),
              $2,
              5,
              '2026-07-31 00:00:04'
            ),
            (
              $4,
              $1,
              NULL,
              $5,
              'input.rejected',
              '{"version":1,"parts":[{"type":"text","text":"Catch-up rejected goal"}]}'::jsonb,
              'Catch-up goal run rejected',
              jsonb_build_object('objectiveBrief', $6::text),
              $3,
              6,
              '2026-07-31 00:00:05'
            )
        `,
        [
          threadId,
          catchupContextId,
          catchupClaimedEventId,
          catchupRejectedEventId,
          goalId,
          catchupObjectiveBrief,
          catchupRunId,
        ],
      );

      await applyMigrationsUpTo(client, 777);

      const finalContexts = await client.query<{
        id: string;
        objectiveBrief: string;
      }>(`
        SELECT
          "id",
          "objective_brief" AS "objectiveBrief"
        FROM "chat_goal_context"
        ORDER BY "id"
      `);
      assert.deepEqual(finalContexts.rows, [
        { id: contextId, objectiveBrief },
        { id: catchupContextId, objectiveBrief: catchupObjectiveBrief },
      ]);

      const catchupPointers = await client.query<{
        contextId: string | null;
        contextType: string | null;
        id: string;
      }>(
        `
          SELECT
            "id",
            "context_type" AS "contextType",
            "context_id" AS "contextId"
          FROM "chat_events"
          WHERE "id" IN ($1, $2, $3)
          ORDER BY "seq_id"
        `,
        [catchupContextId, catchupClaimedEventId, catchupRejectedEventId],
      );
      assert.deepEqual(catchupPointers.rows, [
        {
          id: catchupContextId,
          contextType: "goal",
          contextId: catchupContextId,
        },
        {
          id: catchupClaimedEventId,
          contextType: "goal",
          contextId: catchupContextId,
        },
        {
          id: catchupRejectedEventId,
          contextType: "goal",
          contextId: catchupContextId,
        },
      ]);

      const legacyColumns = await client.query<{ count: string }>(`
        SELECT count(*)::text AS "count"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'chat_events'
          AND "column_name" = 'goal_snapshot'
      `);
      assert.deepEqual(legacyColumns.rows, [{ count: "0" }]);

      await expectAppendOnlyUpdateRejected(client, {
        tableName: "chat_events",
        query: `
          UPDATE "chat_events"
          SET "context_id" = NULL
          WHERE "id" = $1
        `,
        rowId: catchupContextId,
      });

      await client.query(`DELETE FROM "chat_threads" WHERE "id" = $1`, [
        threadId,
      ]);
      const remainingContexts = await client.query<{ count: string }>(`
        SELECT count(*)::text AS "count"
        FROM "chat_goal_context"
      `);
      assert.deepEqual(remainingContexts.rows, [{ count: "0" }]);

      console.log(
        "   ✅ One goal context backfills across each three-row revoke chain",
      );
      console.log(
        "   ✅ The contraction catches up deployment-window rows and drops goal_snapshot",
      );
      console.log(
        "   ✅ Goal context has no secondary index and cascades only with its thread\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateGithubIssueSessionContraction(): Promise<void> {
  console.log("=== Validate legacy GitHub issue session contraction ===\n");
  const testDb = "migration_github_issue_session_contraction_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 760);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      const beforeDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.github_issue_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(beforeDrop.rows, [
        { legacy_session_table: "github_issue_sessions" },
      ]);

      await applyMigrationsUpTo(client, 761);

      const afterDrop = await client.query<{
        legacy_session_table: string | null;
      }>(`
        SELECT to_regclass(
          'public.github_issue_sessions'
        )::text AS "legacy_session_table"
      `);
      assert.deepEqual(afterDrop.rows, [{ legacy_session_table: null }]);
      console.log("   ✅ Legacy GitHub issue session table is removed\n");
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateOrgPlanEntitlementBackfill(): Promise<void> {
  console.log(
    "=== Phase 1.8: Validate existing org plan entitlement backfill ===\n",
  );
  const testDb = "migration_org_plan_entitlement_backfill_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 641);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO "org_metadata" ("org_id", "tier", "credits")
        VALUES
          ('entitlement-backfill-1', 'free', 0),
          ('entitlement-backfill-2', 'limited-free-1', 0),
          ('entitlement-backfill-3', 'pro-suspend', 0),
          ('entitlement-backfill-4', 'pro', 0),
          ('entitlement-backfill-5', 'team', 0),
          ('entitlement-backfill-6', 'custom', 0)
      `);

      await applyMigrationsUpTo(client, 642);

      const entitlements = await client.query<{
        autoRechargeAllowed: boolean;
        baseConcurrencyLimit: number;
        canBuyConcurrency: boolean;
        canBuyCredits: boolean;
        orgId: string;
        planKey: string;
        restrictedVm0Models: boolean;
        source: string;
        status: string;
        supportByok: boolean;
        videoGenerationAllowed: boolean;
        workflowWebhookTriggerAllowed: boolean;
      }>(`
        SELECT
          "org_id" AS "orgId",
          "plan_key" AS "planKey",
          "source",
          "status",
          "base_concurrency_limit" AS "baseConcurrencyLimit",
          "can_buy_concurrency" AS "canBuyConcurrency",
          "can_buy_credits" AS "canBuyCredits",
          "auto_recharge_allowed" AS "autoRechargeAllowed",
          "support_byok" AS "supportByok",
          "restricted_vm0_models" AS "restrictedVm0Models",
          "video_generation_allowed" AS "videoGenerationAllowed",
          "workflow_webhook_trigger_allowed" AS "workflowWebhookTriggerAllowed"
        FROM "org_plan_entitlements"
        WHERE "org_id" LIKE 'entitlement-backfill-%'
        ORDER BY "org_id"
      `);
      assert.deepEqual(entitlements.rows, [
        {
          orgId: "entitlement-backfill-1",
          planKey: "free",
          source: "org_metadata_migration",
          status: "active",
          baseConcurrencyLimit: 1,
          canBuyConcurrency: false,
          canBuyCredits: true,
          autoRechargeAllowed: false,
          supportByok: true,
          restrictedVm0Models: false,
          videoGenerationAllowed: true,
          workflowWebhookTriggerAllowed: false,
        },
        {
          orgId: "entitlement-backfill-2",
          planKey: "limited-free-1",
          source: "org_metadata_migration",
          status: "active",
          baseConcurrencyLimit: 1,
          canBuyConcurrency: false,
          canBuyCredits: false,
          autoRechargeAllowed: false,
          supportByok: false,
          restrictedVm0Models: true,
          videoGenerationAllowed: false,
          workflowWebhookTriggerAllowed: false,
        },
        {
          orgId: "entitlement-backfill-3",
          planKey: "pro-suspend",
          source: "org_metadata_migration",
          status: "suspended",
          baseConcurrencyLimit: 0,
          canBuyConcurrency: false,
          canBuyCredits: false,
          autoRechargeAllowed: false,
          supportByok: false,
          restrictedVm0Models: true,
          videoGenerationAllowed: false,
          workflowWebhookTriggerAllowed: false,
        },
        {
          orgId: "entitlement-backfill-4",
          planKey: "pro",
          source: "org_metadata_migration",
          status: "active",
          baseConcurrencyLimit: 2,
          canBuyConcurrency: false,
          canBuyCredits: true,
          autoRechargeAllowed: true,
          supportByok: true,
          restrictedVm0Models: false,
          videoGenerationAllowed: true,
          workflowWebhookTriggerAllowed: false,
        },
        {
          orgId: "entitlement-backfill-5",
          planKey: "team",
          source: "org_metadata_migration",
          status: "active",
          baseConcurrencyLimit: 10,
          canBuyConcurrency: true,
          canBuyCredits: true,
          autoRechargeAllowed: true,
          supportByok: true,
          restrictedVm0Models: false,
          videoGenerationAllowed: true,
          workflowWebhookTriggerAllowed: true,
        },
        {
          orgId: "entitlement-backfill-6",
          planKey: "custom",
          source: "org_metadata_migration",
          status: "active",
          baseConcurrencyLimit: 10,
          canBuyConcurrency: true,
          canBuyCredits: true,
          autoRechargeAllowed: true,
          supportByok: true,
          restrictedVm0Models: false,
          videoGenerationAllowed: true,
          workflowWebhookTriggerAllowed: true,
        },
      ]);
      console.log(
        "   ✅ Existing metadata-only orgs receive complete plan entitlements\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

async function validateModelObservationContractCleanup(): Promise<void> {
  console.log("=== Phase 1.9: Validate model observation cleanup ===\n");
  const testDb = "migration_model_observation_cleanup_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 676);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO "model_usage_observation" (
          "idempotency_key",
          "model",
          "input_tokens",
          "output_tokens",
          "cache_read_input_tokens",
          "cache_creation_input_tokens",
          "observed_at"
        )
        VALUES (
          '66600000-0000-4000-8000-000000000001',
          'claude-sonnet-4-6',
          10,
          20,
          30,
          40,
          '2026-07-24 00:00:00'
        )
      `);

      await client.query(`
        INSERT INTO "model_stat" (
          "hour_start",
          "model",
          "input_tokens",
          "output_tokens",
          "cache_read_input_tokens",
          "cache_creation_input_tokens",
          "total_tokens"
        )
        VALUES (
          '2026-07-24 00:00:00',
          'claude-sonnet-4-6',
          10,
          20,
          30,
          40,
          100
        )
      `);

      await applyMigrationsUpTo(client, 676);

      const compactRows = await client.query<{
        cacheCreationInputTokens: string;
        cacheReadInputTokens: string;
        inputTokens: string;
        model: string;
        outputTokens: string;
      }>(`
        SELECT
          "model",
          "input_tokens"::text AS "inputTokens",
          "output_tokens"::text AS "outputTokens",
          "cache_read_input_tokens"::text AS "cacheReadInputTokens",
          "cache_creation_input_tokens"::text AS "cacheCreationInputTokens"
        FROM "model_usage_observation"
      `);
      assert.deepEqual(compactRows.rows, [
        {
          model: "claude-sonnet-4-6",
          inputTokens: "10",
          outputTokens: "20",
          cacheReadInputTokens: "30",
          cacheCreationInputTokens: "40",
        },
      ]);

      const modelStatRows = await client.query<{
        cacheCreationInputTokens: string;
        cacheReadInputTokens: string;
        inputTokens: string;
        model: string;
        outputTokens: string;
        totalTokens: string;
      }>(`
        SELECT
          "model",
          "input_tokens"::text AS "inputTokens",
          "output_tokens"::text AS "outputTokens",
          "cache_read_input_tokens"::text AS "cacheReadInputTokens",
          "cache_creation_input_tokens"::text AS "cacheCreationInputTokens",
          "total_tokens"::text AS "totalTokens"
        FROM "model_stat"
      `);
      assert.deepEqual(modelStatRows.rows, [
        {
          model: "claude-sonnet-4-6",
          inputTokens: "10",
          outputTokens: "20",
          cacheReadInputTokens: "30",
          cacheCreationInputTokens: "40",
          totalTokens: "100",
        },
      ]);

      const contractState = await client.query<{
        activeKeyPresent: boolean;
        legacyColumnsAbsent: boolean;
        legacyKeyAbsent: boolean;
        compatibilityViewAbsent: boolean;
      }>(`
        SELECT
          to_regclass('public.compact_model_usage_observation') IS NULL
            AS "compatibilityViewAbsent",
          NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'model_stat'
              AND column_name IN (
                'model_provider',
                'request_count',
                'org_count',
                'user_count',
                'credits_charged'
              )
          ) AS "legacyColumnsAbsent",
          NOT EXISTS (
            SELECT 1
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'model_stat'
              AND indexname = 'uq_model_stat_hour_model_provider'
          ) AS "legacyKeyAbsent",
          EXISTS (
            SELECT 1
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'model_stat'
              AND indexname = 'uq_model_stat_hour_model'
          ) AS "activeKeyPresent"
      `);
      assert.deepEqual(contractState.rows, [
        {
          compatibilityViewAbsent: true,
          legacyColumnsAbsent: true,
          legacyKeyAbsent: true,
          activeKeyPresent: true,
        },
      ]);
      console.log(
        "   ✅ Active compact and ranking data survive legacy schema cleanup\n",
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
}

const BROWSER_RESIZE_STATE_PREVIOUS_MIGRATION = 736;
const BROWSER_RESIZE_STATE_MIGRATION = 737;

const browserResizeRolloutFixture = {
  orgId: "browser-resize-rollout-org",
  userId: "browser-resize-rollout-user",
  profileId: "98000000-0000-4000-8000-000000000001",
  providerProfileId: "98000000-0000-4000-8000-000000000002",
  instances: [
    {
      browserSessionId: "98000000-0000-4000-8000-000000000011",
      chatThreadId: "98000000-0000-4000-8000-000000000012",
      runId: "98000000-0000-4000-8000-000000000013",
      providerSessionId: "98000000-0000-4000-8000-000000000014",
    },
    {
      browserSessionId: "98000000-0000-4000-8000-000000000021",
      chatThreadId: "98000000-0000-4000-8000-000000000022",
      runId: "98000000-0000-4000-8000-000000000023",
      providerSessionId: "98000000-0000-4000-8000-000000000024",
    },
    {
      browserSessionId: "98000000-0000-4000-8000-000000000031",
      chatThreadId: "98000000-0000-4000-8000-000000000032",
      runId: "98000000-0000-4000-8000-000000000033",
      providerSessionId: "98000000-0000-4000-8000-000000000034",
    },
  ],
} as const;

async function seedBrowserResizeRolloutSessions(client: Client): Promise<void> {
  const fixture = browserResizeRolloutFixture;
  await client.query(
    `INSERT INTO "browser_profiles" (
       "id", "org_id", "user_id", "provider_profile_id"
     )
     VALUES ($1, $2, $3, $4)`,
    [
      fixture.profileId,
      fixture.orgId,
      fixture.userId,
      fixture.providerProfileId,
    ],
  );
  for (const instance of fixture.instances) {
    await client.query(
      `INSERT INTO "browser_sessions" (
         "id", "chat_thread_id", "org_id", "user_id", "name",
         "browser_profile_id", "status", "timeout_minutes", "max_credits"
       )
       VALUES ($1, $2, $3, $4, 'resize-rollout', $5, 'active', 240, 1)`,
      [
        instance.browserSessionId,
        instance.chatThreadId,
        fixture.orgId,
        fixture.userId,
        fixture.profileId,
      ],
    );
  }
}

async function insertBrowserInstanceWithPreviousApiShape(
  client: Client,
  instance: (typeof browserResizeRolloutFixture.instances)[number],
): Promise<void> {
  const inserted = await client.query<{ providerSessionId: string }>(
    `INSERT INTO "browser_session_instances" (
       "provider_session_id", "browser_session_id", "chat_thread_id", "run_id",
       "status", "pricing_unit_price", "pricing_unit_size", "timeout_at",
       "started_at", "last_touched_at", "idle_expires_at", "stop_requested_at",
       "finished_at"
     )
     VALUES (
       $1, $2, $3, $4, 'active', 0, 1, NOW() + INTERVAL '4 hours', NOW(),
       NOW(), NOW() + INTERVAL '10 minutes', NULL, NULL
     )
     RETURNING "provider_session_id" AS "providerSessionId"`,
    [
      instance.providerSessionId,
      instance.browserSessionId,
      instance.chatThreadId,
      instance.runId,
    ],
  );
  assert.deepEqual(inserted.rows, [
    { providerSessionId: instance.providerSessionId },
  ]);
}

async function browserResizeStateTableAvailable(
  client: Client,
): Promise<boolean> {
  const result = await client.query<{ available: boolean }>(
    `SELECT to_regclass('public.browser_session_resize_states') IS NOT NULL
       AS "available"`,
  );
  return result.rows[0]?.available ?? false;
}

async function validateBrowserResizeStateRolloutCompatibility(): Promise<void> {
  console.log("=== Validate browser resize state rollout compatibility ===\n");
  const testDb = "migration_browser_resize_state_rollout_test";
  const testDbUrl = createTestDbUrl(testDb);
  const [beforeMigration, previousAfterMigration, currentAfterMigration] =
    browserResizeRolloutFixture.instances;

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, BROWSER_RESIZE_STATE_PREVIOUS_MIGRATION);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await seedBrowserResizeRolloutSessions(client);
      assert.equal(await browserResizeStateTableAvailable(client), false);
      await insertBrowserInstanceWithPreviousApiShape(client, beforeMigration);

      await applyMigrationsUpToInTransaction(
        client,
        BROWSER_RESIZE_STATE_MIGRATION,
      );
      assert.equal(await browserResizeStateTableAvailable(client), true);
      await insertBrowserInstanceWithPreviousApiShape(
        client,
        previousAfterMigration,
      );
      await insertBrowserInstanceWithPreviousApiShape(
        client,
        currentAfterMigration,
      );
      await client.query(
        `INSERT INTO "browser_session_resize_states" (
           "provider_session_id", "screen_width", "screen_height"
         )
         VALUES ($1, 1440, 900)`,
        [currentAfterMigration.providerSessionId],
      );

      const states = await client.query<{
        providerSessionId: string;
        screenHeight: number | null;
        screenWidth: number | null;
      }>(
        `SELECT
           instances."provider_session_id" AS "providerSessionId",
           resize_state."screen_width" AS "screenWidth",
           resize_state."screen_height" AS "screenHeight"
         FROM "browser_session_instances" AS instances
         LEFT JOIN "browser_session_resize_states" AS resize_state
           ON resize_state."provider_session_id" =
             instances."provider_session_id"
         ORDER BY instances."provider_session_id"`,
      );
      assert.deepEqual(states.rows, [
        {
          providerSessionId: beforeMigration.providerSessionId,
          screenHeight: null,
          screenWidth: null,
        },
        {
          providerSessionId: previousAfterMigration.providerSessionId,
          screenHeight: null,
          screenWidth: null,
        },
        {
          providerSessionId: currentAfterMigration.providerSessionId,
          screenHeight: 900,
          screenWidth: 1440,
        },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
  console.log(
    "   ✅ Current API tolerates pre-0737 schema, previous API inserts after 0737, and only current post-migration instances gain resize state\n",
  );
}

const CUSTOM_MODEL_GATEWAY_PREVIOUS_MIGRATION = 763;
const CUSTOM_MODEL_GATEWAY_MIGRATION = 764;

async function customModelGatewaySchemaAvailable(
  client: Client,
): Promise<boolean> {
  const result = await client.query<{ available: boolean }>(
    `SELECT
       to_regclass('public.model_provider_connections') IS NOT NULL
       AND to_regclass('public.model_provider_surfaces') IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'org_model_policies'
           AND column_name = 'model_provider_surface_id'
       ) AS "available"`,
  );
  return result.rows[0]?.available ?? false;
}

async function selectModelPoliciesWithCurrentApiShape(
  client: Client,
  gatewaySchemaAvailable: boolean,
): Promise<{ model: string; modelProviderSurfaceId: string | null }[]> {
  const surfaceColumn = gatewaySchemaAvailable
    ? `"model_provider_surface_id"`
    : `NULL::uuid`;
  const result = await client.query<{
    model: string;
    modelProviderSurfaceId: string | null;
  }>(
    `SELECT
       "model",
       ${surfaceColumn} AS "modelProviderSurfaceId"
     FROM "org_model_policies"
     WHERE "org_id" = $1
     ORDER BY "model"`,
    ["custom-model-gateway-rollout-org"],
  );
  return result.rows;
}

async function insertModelPolicyWithPreviousApiShape(
  client: Client,
  model: string,
  isDefault: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO "org_model_policies" (
       "org_id", "model", "is_default", "default_provider_type",
       "credential_scope", "model_provider_id", "created_by_user_id",
       "updated_by_user_id"
     )
     VALUES ($1, $2, $3, 'vm0', 'org', NULL, 'rollout-user', 'rollout-user')`,
    ["custom-model-gateway-rollout-org", model, isDefault],
  );
}

async function validateCustomModelGatewayRolloutCompatibility(): Promise<void> {
  console.log("=== Validate custom model gateway rollout compatibility ===\n");
  const testDb = "migration_custom_model_gateway_rollout_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, CUSTOM_MODEL_GATEWAY_PREVIOUS_MIGRATION);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await insertModelPolicyWithPreviousApiShape(
        client,
        "rollout-model-before",
        true,
      );
      assert.equal(await customModelGatewaySchemaAvailable(client), false);
      assert.deepEqual(
        await selectModelPoliciesWithCurrentApiShape(client, false),
        [
          {
            model: "rollout-model-before",
            modelProviderSurfaceId: null,
          },
        ],
      );
      await applyMigrationsUpToInTransaction(
        client,
        CUSTOM_MODEL_GATEWAY_MIGRATION,
      );
      assert.equal(await customModelGatewaySchemaAvailable(client), true);
      await insertModelPolicyWithPreviousApiShape(
        client,
        "rollout-model-after",
        false,
      );
      assert.deepEqual(
        await selectModelPoliciesWithCurrentApiShape(client, true),
        [
          {
            model: "rollout-model-after",
            modelProviderSurfaceId: null,
          },
          {
            model: "rollout-model-before",
            modelProviderSurfaceId: null,
          },
        ],
      );
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
  console.log(
    "   ✅ Current API reads the pre-0764 policy shape and previous API writes remain valid after 0764\n",
  );
}

type HostedSiteScopeMigrationWrite = {
  readonly chatThreadId: string | null;
  readonly requestedSlug: string | null;
};

type HostedSiteScopeMigrationWriteOutcome =
  | { readonly kind: "success"; readonly row: HostedSiteScopeMigrationWrite }
  | { readonly kind: "failure"; readonly error: unknown };

async function applyHostedSiteScopeMigrationWithConcurrentWriter(args: {
  readonly dbUrl: string;
  readonly observer: Client;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<HostedSiteScopeMigrationWrite> {
  const migration = new Client({ connectionString: args.dbUrl });
  const previousApi = new Client({ connectionString: args.dbUrl });
  await migration.connect();
  await previousApi.connect();

  const migrationSql = await fs.readFile(
    path.join(MIGRATIONS_DIR, "0753_backfill_chat_scoped_hosted_sites.sql"),
    "utf-8",
  );
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  const [lockStatement, ...remainingStatements] = statements;
  if (!lockStatement) {
    throw new Error("Hosted-site scope migration has no statements");
  }
  assert.match(lockStatement, /^LOCK TABLE "hosted_sites"/u);

  let migrationOpen = false;
  let writerTask: Promise<HostedSiteScopeMigrationWriteOutcome> | undefined;
  try {
    const migrationPidResult = await migration.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    const previousApiPidResult = await previousApi.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS "pid"`,
    );
    const migrationPid = migrationPidResult.rows[0]?.pid;
    const previousApiPid = previousApiPidResult.rows[0]?.pid;
    assert.ok(migrationPid);
    assert.ok(previousApiPid);

    await migration.query("BEGIN");
    migrationOpen = true;
    await migration.query(lockStatement);

    writerTask = previousApi
      .query<HostedSiteScopeMigrationWrite>(
        `INSERT INTO "hosted_sites" (
           "org_id", "user_id", "slug", "public_slug", "created_from_run_id"
         )
         VALUES (
           $1, $2, 'concurrent-previous-api-site',
           'concurrent-previous-api-site', $3
         )
         RETURNING
           "requested_slug" AS "requestedSlug",
           "chat_thread_id" AS "chatThreadId"`,
        [args.orgId, args.userId, args.runId],
      )
      .then(
        (result) => {
          const row = result.rows[0];
          if (!row) {
            throw new Error("Concurrent previous API insert returned no row");
          }
          return { kind: "success", row } as const;
        },
        (error: unknown) => {
          return { kind: "failure", error } as const;
        },
      );

    await waitForMigrationBlockedBy(args.observer, {
      blockerPid: migrationPid,
      migrationPid: previousApiPid,
    });

    for (const statement of remainingStatements) {
      await migration.query(statement);
    }
    await migration.query("COMMIT");
    migrationOpen = false;

    const outcome = await writerTask;
    if (outcome.kind === "failure") {
      throw outcome.error;
    }
    return outcome.row;
  } finally {
    if (migrationOpen) {
      await migration.query("ROLLBACK");
    }
    if (writerTask !== undefined) {
      await writerTask;
    }
    await migration.end();
    await previousApi.end();
  }
}

async function validateHostedSiteChatScopeRollout(): Promise<void> {
  console.log("=== Validate hosted-site chat scope rollout ===\n");
  const testDb = "migration_hosted_site_chat_scope_rollout_test";
  const testDbUrl = createTestDbUrl(testDb);
  const fixture = {
    composeId: "00000000-0000-4000-8000-000000074201",
    sessionId: "00000000-0000-4000-8000-000000074202",
    firstRunId: "00000000-0000-4000-8000-000000074203",
    secondRunId: "00000000-0000-4000-8000-000000074204",
    firstThreadId: "00000000-0000-4000-8000-000000074205",
    secondThreadId: "00000000-0000-4000-8000-000000074206",
    chatSiteId: "00000000-0000-4000-8000-000000074207",
    legacySiteId: "00000000-0000-4000-8000-000000074208",
    orgId: "hosted-site-chat-scope-org",
    userId: "hosted-site-chat-scope-user",
  } as const;

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(testDbUrl, 751);
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
         VALUES ($1, $2, 'hosted-site-chat-scope', $3)`,
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
           ($1, $3, $4, 'running', 'first chat publish', $5),
           ($2, $3, $4, 'running', 'second chat publish', $5)`,
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
           ($1, $3, $4, 'First hosted-site chat'),
           ($2, $3, $4, 'Second hosted-site chat')`,
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
        `INSERT INTO "hosted_sites" (
           "id", "org_id", "user_id", "slug", "public_slug",
           "created_from_run_id"
         )
         VALUES
           ($1, $3, $4, 'shared-site', 'shared-site', $5),
           ($2, $3, $4, 'legacy-site', 'legacy-site', NULL)`,
        [
          fixture.chatSiteId,
          fixture.legacySiteId,
          fixture.orgId,
          fixture.userId,
          fixture.firstRunId,
        ],
      );

      await applyMigrationsUpToInTransaction(client, 752);
      const concurrentPreviousApiInsert =
        await applyHostedSiteScopeMigrationWithConcurrentWriter({
          dbUrl: testDbUrl,
          observer: client,
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId: fixture.firstRunId,
        });
      assert.deepEqual(concurrentPreviousApiInsert, {
        requestedSlug: "concurrent-previous-api-site",
        chatThreadId: fixture.firstThreadId,
      });

      const backfilled = await client.query<{
        chatThreadId: string | null;
        id: string;
        requestedSlug: string | null;
      }>(
        `SELECT
           "id",
           "requested_slug" AS "requestedSlug",
           "chat_thread_id" AS "chatThreadId"
         FROM "hosted_sites"
         WHERE "id" IN ($1, $2)
         ORDER BY "id"`,
        [fixture.chatSiteId, fixture.legacySiteId],
      );
      assert.deepEqual(backfilled.rows, [
        {
          id: fixture.chatSiteId,
          requestedSlug: "shared-site",
          chatThreadId: fixture.firstThreadId,
        },
        {
          id: fixture.legacySiteId,
          requestedSlug: "legacy-site",
          chatThreadId: null,
        },
      ]);

      const previousApiInsert = await client.query<{
        chatThreadId: string | null;
        requestedSlug: string | null;
      }>(
        `INSERT INTO "hosted_sites" (
           "org_id", "user_id", "slug", "public_slug", "created_from_run_id"
         )
         VALUES ($1, $2, 'previous-api-site', 'previous-api-site', $3)
         RETURNING
           "requested_slug" AS "requestedSlug",
           "chat_thread_id" AS "chatThreadId"`,
        [fixture.orgId, fixture.userId, fixture.firstRunId],
      );
      assert.deepEqual(previousApiInsert.rows, [
        {
          requestedSlug: "previous-api-site",
          chatThreadId: fixture.firstThreadId,
        },
      ]);

      await client.query(
        `INSERT INTO "hosted_sites" (
           "org_id", "user_id", "slug", "requested_slug", "chat_thread_id",
           "public_slug"
         )
         VALUES (
           $1, $2, 'shared-site-second-chat', 'shared-site', $3,
           'shared-site-second-chat'
         )`,
        [fixture.orgId, fixture.userId, fixture.secondThreadId],
      );
      await expectDatabaseError(client, {
        code: "23505",
        query: `INSERT INTO "hosted_sites" (
          "org_id", "user_id", "slug", "requested_slug", "chat_thread_id",
          "public_slug"
        )
        VALUES (
          $1, $2, 'shared-site-first-chat-duplicate', 'shared-site', $3,
          'shared-site-first-chat-duplicate'
        )`,
        values: [fixture.orgId, fixture.userId, fixture.firstThreadId],
      });
      await client.query(
        `INSERT INTO "hosted_sites" (
           "org_id", "user_id", "slug", "requested_slug", "public_slug"
         )
         VALUES (
           $1, $2, 'shared-site-organization', 'shared-site',
           'shared-site-organization'
         )`,
        [fixture.orgId, fixture.userId],
      );

      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "Hosted site chat ownership is immutable",
        query: `UPDATE "hosted_sites"
                SET "chat_thread_id" = $1
                WHERE "id" = $2`,
        values: [fixture.secondThreadId, fixture.chatSiteId],
      });

      await client.query(
        `INSERT INTO "hosted_deployments" (
           "site_id", "org_id", "user_id", "run_id", "status", "r2_prefix",
           "manifest", "manifest_hash", "content_hash", "file_count",
           "size_bytes", "url"
         )
         VALUES (
           $1, $2, $3, $4, 'uploading', 'matching-chat', '{}'::jsonb,
           repeat('0', 64), repeat('0', 64), 0, 0,
           'https://matching-chat.invalid'
         )`,
        [fixture.chatSiteId, fixture.orgId, fixture.userId, fixture.firstRunId],
      );
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "Hosted site belongs to a different chat",
        query: `INSERT INTO "hosted_deployments" (
          "site_id", "org_id", "user_id", "run_id", "status", "r2_prefix",
          "manifest", "manifest_hash", "content_hash", "file_count",
          "size_bytes", "url"
        )
        VALUES (
          $1, $2, $3, $4, 'uploading', 'different-chat', '{}'::jsonb,
          repeat('0', 64), repeat('0', 64), 0, 0,
          'https://different-chat.invalid'
        )`,
        values: [
          fixture.chatSiteId,
          fixture.orgId,
          fixture.userId,
          fixture.secondRunId,
        ],
      });

      await client.query(`DELETE FROM "chat_threads" WHERE "id" = $1`, [
        fixture.firstThreadId,
      ]);
      const stableOwner = await client.query<{ chatThreadId: string | null }>(
        `SELECT "chat_thread_id" AS "chatThreadId"
         FROM "hosted_sites"
         WHERE "id" = $1`,
        [fixture.chatSiteId],
      );
      assert.deepEqual(stableOwner.rows, [
        { chatThreadId: fixture.firstThreadId },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }
  console.log(
    "   ✅ Existing and previous-API sites gain stable chat ownership, scoped uniqueness allows cross-chat reuse, and deployment writes fail closed across chats\n",
  );
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
    await runMigrationsUpTo(dbUrl, latestIdx);

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

async function main(): Promise<void> {
  console.log("🧪 Testing Migration Consistency (Schema Comparison)\n");

  const TEST_DB_1 = "migration_test_existing";
  const TEST_DB_2 = "migration_test_generated";
  let migrationsBackedUp = false;

  try {
    // Step 0: Validate snapshot files
    await validateSnapshotFiles();

    // Step 0.5: Validate timestamp ordering
    await validateTimestampOrdering();

    await validateConnectorCredentialOwnershipBackfill();
    await validateConnectorCredentialOwnershipContraction();
    await validateConnectorSlugRollout();
    await validateInsightsConnectorSlugExpansion();
    await validateInsightsConnectorTypeCleanup();

    await validateStorageArchiveSizeFinalization();
    await validateStorageLegacyTypeContraction();
    await validateLegacyMemoryCleanup();
    await validateSessionStorageBackfill();
    await validateSlackChatThreadRouteBackfill();
    await validateSlackLegacySchemaContraction();
    await validateTeamsThreadSessionContraction();
    await validateTelegramThreadSessionContraction();
    await validateAgentPhoneThreadSessionContraction();
    await validateFeishuThreadSessionContraction();
    await validateGithubIssueSessionContraction();
    await validateChatDisplayContextBackfill();
    await validateChatAutomationContextBackfill();
    await validateChatGoalContextBackfill();
    await validateOrgPlanEntitlementBackfill();
    await validateModelObservationContractCleanup();
    await validateChatEventTypeBackfillAndContract();
    await validateStructuredPromptDraftBackfill();
    await validateUserMessageBackfillAndContract();
    await validateCanonicalUserMessageRolloutCompatibility();
    await validateCanonicalUserMessageContraction();
    await validateDraftContentContraction();
    await validateChatEventQueueContraction();
    await validateChatMessageRoleContraction();
    await validateChatEventTableRename();
    await validateChatInputGoalEvent();
    await validateChatEventAssetRefTableRename();
    await validateChatEventPropertyColumnRollout();
    await validateBrowserResizeStateRolloutCompatibility();
    await validateCustomModelGatewayRolloutCompatibility();
    await validateHostedSiteChatScopeRollout();
    await validateCurrentBrowserApiBeforeBillingMigration();
    await validateConnectorCatalogCompatibilityFormatRollout();

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

    await validateThreadBrowserIdentityAfterMigration(dbUrl1);
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
        "   ✅ Thread browser identity keeps previous-API rollout compatibility",
      );
      console.log(
        "   ✅ Current browser API can start before billing migration",
      );
      console.log("   ✅ Chat event source tables reject UPDATE");
      console.log(
        "   ✅ Final connector catalog constraints reject invalid state",
      );
      console.log(
        "   ✅ Custom connector OAuth mode constraints reject mismatched configuration",
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
