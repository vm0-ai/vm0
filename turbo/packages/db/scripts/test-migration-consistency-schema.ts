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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  connectorSlugLegacyInsertConnectors,
  connectorSlugLegacyInsertExternalCodeSessions,
  connectorSlugLegacyInsertOauthDeviceSessions,
  connectorSlugLegacyInsertOauthStates,
  connectorSlugLegacyInsertUserConnectors,
  connectorSlugLegacyInsertUserPermissionGrants,
} from "../src/compat/connector-slug-legacy-insert";
import { connectorExternalCodeSessions } from "../src/schema/connector-external-code-session";
import { connectorOauthDeviceAuthorizationSessions } from "../src/schema/connector-oauth-device-authorization-session";
import { connectorOauthStates } from "../src/schema/connector-oauth-state";
import { connectors } from "../src/schema/connector";
import { userConnectors } from "../src/schema/user-connector";
import { userPermissionGrants } from "../src/schema/user-permission-grant";

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

async function validatePreviousBrowserApiAfterBillingMigration(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.4: Validate previous browser API after billing migration ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const browserProfileId = "00000000-0000-4000-8000-000000073501";
  const providerProfileId = "00000000-0000-4000-8000-000000073502";
  const browserSessionId = "00000000-0000-4000-8000-000000073503";
  const providerSessionId = "00000000-0000-4000-8000-000000073504";
  const chatThreadId = "00000000-0000-4000-8000-000000073505";
  const runId = "00000000-0000-4000-8000-000000073506";

  try {
    // This is the lookup shape used by the previous API before every provider
    // create or resume.
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
      [browserProfileId, providerProfileId],
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
      [browserSessionId, chatThreadId, browserProfileId],
    );
    const started = await client.query<{
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
        providerSessionId,
        browserSessionId,
        chatThreadId,
        runId,
        pricingRow.unitPrice,
        pricingRow.unitSize,
      ],
    );
    assert.deepEqual(started.rows, [
      { pricingUnitPrice: "0", pricingUnitSize: "1" },
    ]);
    console.log("   ✅ previous API pricing lookup returns a zero-priced row");
    console.log("   ✅ previous API provider-start write remains valid\n");
  } finally {
    await client.query(`DELETE FROM "browser_sessions" WHERE "id" = $1`, [
      browserSessionId,
    ]);
    await client.query(`DELETE FROM "browser_profiles" WHERE "id" = $1`, [
      browserProfileId,
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
        "user_message"
      )
      VALUES (
        $1,
        NULL,
        'input.prompt',
        $2::jsonb
      )
      RETURNING
        "id",
        "seq_id" AS "seqId",
        "content",
        "user_message" AS "userMessage"
    `,
    [threadId, JSON.stringify(userMessage)],
  );
  const messageRow = message.rows[0];
  if (!messageRow) {
    throw new Error("Failed to create append-only chat message fixture");
  }
  assert.equal(messageRow.seqId, "1");
  assert.equal(messageRow.content, null);
  assert.deepEqual(messageRow.userMessage, userMessage);

  const nextMessage = await client.query<{ seqId: string }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "content",
        "event_type"
      )
      VALUES (
        $1,
        'second typed API migration test',
        'output.message'
      )
      RETURNING "seq_id" AS "seqId"
    `,
    [threadId],
  );
  assert.equal(nextMessage.rows[0]?.seqId, "2");

  const sequenceState = await client.query<{ lastSeqId: string }>(
    `
      SELECT "last_chat_message_seq_id" AS "lastSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [threadId],
  );
  assert.equal(sequenceState.rows[0]?.lastSeqId, "2");

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
      SET
        "draft_content" = 'canonical API draft',
        "draft_user_message" = $2::jsonb
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

    // Insert through the canonical table without seq_id and rely on the
    // database allocator.
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
    console.log("   ✅ chat event writes receive database-allocated seq_ids\n");
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

type ConnectorSlugSqlValue = string | number | null;

type ConnectorSlugCompatibilitySpec = {
  readonly tableName:
    | "connector_external_code_sessions"
    | "connector_oauth_device_authorization_sessions"
    | "connector_oauth_states"
    | "connectors"
    | "user_connectors"
    | "user_permission_grants";
  readonly legacyColumn: "connector_ref" | "connector_type" | "type";
  readonly originalId: string;
  readonly originalSlug: string;
  readonly slugKey: string;
  readonly baseColumns: readonly string[];
  readonly baseValues: (suffix: string) => readonly ConnectorSlugSqlValue[];
  readonly conflictColumns: readonly string[];
  readonly conflictWhere?: string;
};

type ConnectorSlugInsertArgs = {
  readonly canonicalSlug?: string;
  readonly conflictAction?: "nothing" | "update-legacy";
  readonly explicitId?: string;
  readonly legacySlug?: string;
  readonly returnExpandedIdentity: boolean;
  readonly suffix: string;
};

type ConnectorSlugInsertStatement = {
  readonly query: string;
  readonly values: readonly ConnectorSlugSqlValue[];
};

type ConnectorSlugIdentityRow = {
  readonly connectorSlug: string;
  readonly id: string;
  readonly legacyValue: string;
};

const CONNECTOR_SLUG_EXPANSION_AGENT_ID =
  "71000000-0000-4000-8000-000000000099";
const CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID =
  "71000000-0000-4000-8000-000000000098";
const CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTION_ID =
  "71000000-0000-4000-8000-000000000097";
const CONNECTOR_SLUG_EXPANSION_CUSTOM_OAUTH_STATE_ID =
  "71000000-0000-4000-8000-000000000096";
const CONNECTOR_SLUG_EXPANSION_PREVIOUS_MIGRATION = 737;
const CONNECTOR_SLUG_EXPANSION_MIGRATION = 738;
const connectorSlugLegacyInsertIds = {
  connector_external_code_sessions: "71000000-0000-4000-8000-000000000085",
  connector_oauth_device_authorization_sessions:
    "71000000-0000-4000-8000-000000000084",
  connector_oauth_states: "71000000-0000-4000-8000-000000000083",
  connectors: "71000000-0000-4000-8000-000000000081",
  user_connectors: "71000000-0000-4000-8000-000000000082",
  user_permission_grants: "71000000-0000-4000-8000-000000000086",
} as const;
const connectorSlugLegacyInsertValues = {
  connector_external_code_sessions: "x",
  connector_oauth_device_authorization_sessions: "youtube",
  connector_oauth_states: "gmail",
  connectors: "google-drive",
  user_connectors: "google-calendar",
  user_permission_grants: "slack",
} as const;

const connectorSlugCompatibilitySpecs: readonly ConnectorSlugCompatibilitySpec[] =
  [
    {
      tableName: "connectors",
      legacyColumn: "type",
      originalId: "71000000-0000-4000-8000-000000000001",
      originalSlug: "github",
      slugKey: "connector",
      baseColumns: ["auth_method", "storage_version", "user_id", "org_id"],
      baseValues: (suffix) => {
        return [
          "oauth",
          1,
          `connector-slug-user-${suffix}`,
          "connector-slug-org",
        ];
      },
      conflictColumns: ["org_id", "user_id", "type"],
      conflictWhere: '"type" IS NOT NULL',
    },
    {
      tableName: "user_connectors",
      legacyColumn: "connector_type",
      originalId: "71000000-0000-4000-8000-000000000002",
      originalSlug: "notion",
      slugKey: "user-connector",
      baseColumns: ["org_id", "user_id", "agent_id"],
      baseValues: (suffix) => {
        return [
          "connector-slug-org",
          `connector-slug-user-${suffix}`,
          CONNECTOR_SLUG_EXPANSION_AGENT_ID,
        ];
      },
      conflictColumns: ["org_id", "user_id", "agent_id", "connector_type"],
    },
    {
      tableName: "connector_oauth_states",
      legacyColumn: "type",
      originalId: "71000000-0000-4000-8000-000000000003",
      originalSlug: "linear",
      slugKey: "oauth-state",
      baseColumns: [
        "state",
        "auth_method",
        "user_id",
        "org_id",
        "redirect_uri",
        "expires_at",
      ],
      baseValues: (suffix) => {
        return [
          `connector-slug-state-${suffix}`,
          "oauth",
          `connector-slug-user-${suffix}`,
          "connector-slug-org",
          "https://example.com/callback",
          "2030-01-01T00:00:00.000Z",
        ];
      },
      conflictColumns: ["state"],
    },
    {
      tableName: "connector_oauth_device_authorization_sessions",
      legacyColumn: "connector_type",
      originalId: "71000000-0000-4000-8000-000000000004",
      originalSlug: "github",
      slugKey: "device-session",
      baseColumns: [
        "org_id",
        "user_id",
        "auth_method",
        "session_token_hash",
        "encrypted_provider_state",
        "user_code",
        "verification_uri",
        "interval_seconds",
        "expires_at",
      ],
      baseValues: (suffix) => {
        return [
          "connector-slug-org",
          `connector-slug-user-${suffix}`,
          "oauth-device",
          `connector-slug-device-token-${suffix}`,
          `encrypted-device-state-${suffix}`,
          `device-code-${suffix}`,
          "https://example.com/device",
          5,
          "2030-01-01T00:00:00.000Z",
        ];
      },
      conflictColumns: ["session_token_hash"],
    },
    {
      tableName: "connector_external_code_sessions",
      legacyColumn: "connector_type",
      originalId: "71000000-0000-4000-8000-000000000005",
      originalSlug: "x",
      slugKey: "external-session",
      baseColumns: [
        "org_id",
        "user_id",
        "auth_method",
        "session_token_hash",
        "encrypted_provider_state",
        "authorization_url",
        "expires_at",
      ],
      baseValues: (suffix) => {
        return [
          "connector-slug-org",
          `connector-slug-user-${suffix}`,
          "external-code",
          `connector-slug-external-token-${suffix}`,
          `encrypted-external-state-${suffix}`,
          `https://example.com/authorize/${suffix}`,
          "2030-01-01T00:00:00.000Z",
        ];
      },
      conflictColumns: ["session_token_hash"],
    },
    {
      tableName: "user_permission_grants",
      legacyColumn: "connector_ref",
      originalId: "71000000-0000-4000-8000-000000000006",
      originalSlug: "slack",
      slugKey: "permission-grant",
      baseColumns: ["org_id", "user_id", "agent_id", "permission", "action"],
      baseValues: (suffix) => {
        return [
          "connector-slug-org",
          `connector-slug-user-${suffix}`,
          CONNECTOR_SLUG_EXPANSION_AGENT_ID,
          `channels:read:${suffix}`,
          "allow",
        ];
      },
      conflictColumns: [
        "org_id",
        "user_id",
        "agent_id",
        "connector_ref",
        "permission",
      ],
    },
  ];

function buildConnectorSlugInsert(
  spec: ConnectorSlugCompatibilitySpec,
  args: ConnectorSlugInsertArgs,
): ConnectorSlugInsertStatement {
  const columns = [...spec.baseColumns];
  const values = [...spec.baseValues(args.suffix)];

  if (args.explicitId !== undefined) {
    columns.unshift("id");
    values.unshift(args.explicitId);
  }
  if (args.legacySlug !== undefined) {
    columns.push(spec.legacyColumn);
    values.push(args.legacySlug);
  }
  if (args.canonicalSlug !== undefined) {
    columns.push("connector_slug");
    values.push(args.canonicalSlug);
  }

  const quotedColumns = columns.map((column) => {
    return `"${column}"`;
  });
  const placeholders = values.map((_value, index) => {
    return `$${index + 1}`;
  });
  let conflictClause = "";
  if (args.conflictAction === "nothing") {
    conflictClause = "ON CONFLICT DO NOTHING";
  } else if (args.conflictAction === "update-legacy") {
    const conflictTarget = spec.conflictColumns
      .map((column) => {
        return `"${column}"`;
      })
      .join(", ");
    const conflictWhere =
      spec.conflictWhere === undefined ? "" : ` WHERE ${spec.conflictWhere}`;
    conflictClause = `ON CONFLICT (${conflictTarget})${conflictWhere} DO UPDATE
      SET "${spec.legacyColumn}" = EXCLUDED."${spec.legacyColumn}"`;
  }

  const returning = args.returnExpandedIdentity
    ? `RETURNING
        "id",
        "${spec.legacyColumn}" AS "legacyValue",
        "connector_slug" AS "connectorSlug"`
    : `RETURNING "id"`;

  return {
    query: `
      INSERT INTO "${spec.tableName}" (${quotedColumns.join(", ")})
      VALUES (${placeholders.join(", ")})
      ${conflictClause}
      ${returning}
    `,
    values,
  };
}

async function insertConnectorSlugRow(
  client: Client,
  spec: ConnectorSlugCompatibilitySpec,
  args: ConnectorSlugInsertArgs,
): Promise<readonly ConnectorSlugIdentityRow[]> {
  const statement = buildConnectorSlugInsert(spec, args);
  const result = await client.query<ConnectorSlugIdentityRow>(statement.query, [
    ...statement.values,
  ]);
  return result.rows;
}

function requireSingleResultRow<T>(rows: readonly T[]): T {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row;
}

async function validateExpandedBuildAgainstConnectorSlugPredecessor(
  client: Client,
): Promise<void> {
  const database = drizzle(client);
  const connectorSpec = connectorSlugCompatibilitySpecs.find((spec) => {
    return spec.tableName === "connectors";
  });
  const userConnectorSpec = connectorSlugCompatibilitySpecs.find((spec) => {
    return spec.tableName === "user_connectors";
  });
  const oauthStateSpec = connectorSlugCompatibilitySpecs.find((spec) => {
    return spec.tableName === "connector_oauth_states";
  });
  const deviceSessionSpec = connectorSlugCompatibilitySpecs.find((spec) => {
    return spec.tableName === "connector_oauth_device_authorization_sessions";
  });
  const externalCodeSessionSpec = connectorSlugCompatibilitySpecs.find(
    (spec) => {
      return spec.tableName === "connector_external_code_sessions";
    },
  );
  const permissionGrantSpec = connectorSlugCompatibilitySpecs.find((spec) => {
    return spec.tableName === "user_permission_grants";
  });
  assert.ok(connectorSpec);
  assert.ok(userConnectorSpec);
  assert.ok(oauthStateSpec);
  assert.ok(deviceSessionSpec);
  assert.ok(externalCodeSessionSpec);
  assert.ok(permissionGrantSpec);

  assert.equal(
    (
      await database
        .select({ id: connectors.id, type: connectors.type })
        .from(connectors)
        .where(eq(connectors.id, connectorSpec.originalId))
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectors)
        .set({ type: connectorSpec.originalSlug })
        .where(eq(connectors.id, connectorSpec.originalId))
        .returning({ id: connectors.id, type: connectors.type })
    ).length,
    1,
  );

  assert.equal(
    (
      await database
        .select({
          id: userConnectors.id,
          connectorType: userConnectors.connectorType,
        })
        .from(userConnectors)
        .where(eq(userConnectors.id, userConnectorSpec.originalId))
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(userConnectors)
        .set({
          connectorType: userConnectorSpec.originalSlug,
        })
        .where(eq(userConnectors.id, userConnectorSpec.originalId))
        .returning({
          id: userConnectors.id,
          connectorType: userConnectors.connectorType,
        })
    ).length,
    1,
  );

  assert.equal(
    (
      await database
        .select({
          id: connectorOauthStates.id,
          type: connectorOauthStates.type,
        })
        .from(connectorOauthStates)
        .where(eq(connectorOauthStates.id, oauthStateSpec.originalId))
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectorOauthStates)
        .set({ type: oauthStateSpec.originalSlug })
        .where(eq(connectorOauthStates.id, oauthStateSpec.originalId))
        .returning({
          id: connectorOauthStates.id,
          type: connectorOauthStates.type,
        })
    ).length,
    1,
  );

  assert.equal(
    (
      await database
        .select({
          id: connectorOauthDeviceAuthorizationSessions.id,
          connectorType:
            connectorOauthDeviceAuthorizationSessions.connectorType,
        })
        .from(connectorOauthDeviceAuthorizationSessions)
        .where(
          eq(
            connectorOauthDeviceAuthorizationSessions.id,
            deviceSessionSpec.originalId,
          ),
        )
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectorOauthDeviceAuthorizationSessions)
        .set({
          connectorType: deviceSessionSpec.originalSlug,
        })
        .where(
          eq(
            connectorOauthDeviceAuthorizationSessions.id,
            deviceSessionSpec.originalId,
          ),
        )
        .returning({
          id: connectorOauthDeviceAuthorizationSessions.id,
          connectorType:
            connectorOauthDeviceAuthorizationSessions.connectorType,
        })
    ).length,
    1,
  );

  assert.equal(
    (
      await database
        .select({
          id: connectorExternalCodeSessions.id,
          connectorType: connectorExternalCodeSessions.connectorType,
        })
        .from(connectorExternalCodeSessions)
        .where(
          eq(
            connectorExternalCodeSessions.id,
            externalCodeSessionSpec.originalId,
          ),
        )
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(connectorExternalCodeSessions)
        .set({
          connectorType: externalCodeSessionSpec.originalSlug,
        })
        .where(
          eq(
            connectorExternalCodeSessions.id,
            externalCodeSessionSpec.originalId,
          ),
        )
        .returning({
          id: connectorExternalCodeSessions.id,
          connectorType: connectorExternalCodeSessions.connectorType,
        })
    ).length,
    1,
  );

  assert.equal(
    (
      await database
        .select({
          id: userPermissionGrants.id,
          connectorRef: userPermissionGrants.connectorRef,
        })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.id, permissionGrantSpec.originalId))
    ).length,
    1,
  );
  assert.equal(
    (
      await database
        .update(userPermissionGrants)
        .set({
          connectorRef: permissionGrantSpec.originalSlug,
        })
        .where(eq(userPermissionGrants.id, permissionGrantSpec.originalId))
        .returning({
          id: userPermissionGrants.id,
          connectorRef: userPermissionGrants.connectorRef,
        })
    ).length,
    1,
  );

  assert.deepEqual(
    await database
      .insert(connectorSlugLegacyInsertConnectors)
      .values({
        id: connectorSlugLegacyInsertIds.connectors,
        type: "google-drive",
        authMethod: "oauth",
        storageVersion: 1,
        userId: "connector-slug-current-build-connector-user",
        orgId: "connector-slug-org",
      })
      .returning({ id: connectorSlugLegacyInsertConnectors.id }),
    [{ id: connectorSlugLegacyInsertIds.connectors }],
  );
  assert.deepEqual(
    await database
      .insert(connectorSlugLegacyInsertUserConnectors)
      .values({
        id: connectorSlugLegacyInsertIds.user_connectors,
        orgId: "connector-slug-org",
        userId: "connector-slug-current-build-user-connector-user",
        agentId: CONNECTOR_SLUG_EXPANSION_AGENT_ID,
        connectorType: "google-calendar",
      })
      .returning({ id: connectorSlugLegacyInsertUserConnectors.id }),
    [{ id: connectorSlugLegacyInsertIds.user_connectors }],
  );
  assert.deepEqual(
    await database
      .insert(connectorSlugLegacyInsertOauthStates)
      .values({
        id: connectorSlugLegacyInsertIds.connector_oauth_states,
        state: "connector-slug-current-build-state",
        type: "gmail",
        authMethod: "oauth",
        userId: "connector-slug-current-build-oauth-state-user",
        orgId: "connector-slug-org",
        redirectUri: "https://example.com/current-build/callback",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({ id: connectorSlugLegacyInsertOauthStates.id }),
    [{ id: connectorSlugLegacyInsertIds.connector_oauth_states }],
  );
  assert.deepEqual(
    await database
      .insert(connectorSlugLegacyInsertOauthDeviceSessions)
      .values({
        id: connectorSlugLegacyInsertIds.connector_oauth_device_authorization_sessions,
        orgId: "connector-slug-org",
        userId: "connector-slug-current-build-device-user",
        connectorType: "youtube",
        authMethod: "oauth-device",
        sessionTokenHash: "connector-slug-current-build-device-token",
        encryptedProviderState: "connector-slug-current-build-device-state",
        userCode: "CURRENT-BUILD",
        verificationUri: "https://example.com/current-build/device",
        intervalSeconds: 5,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({
        id: connectorSlugLegacyInsertOauthDeviceSessions.id,
      }),
    [
      {
        id: connectorSlugLegacyInsertIds.connector_oauth_device_authorization_sessions,
      },
    ],
  );
  assert.deepEqual(
    await database
      .insert(connectorSlugLegacyInsertExternalCodeSessions)
      .values({
        id: connectorSlugLegacyInsertIds.connector_external_code_sessions,
        orgId: "connector-slug-org",
        userId: "connector-slug-current-build-external-code-user",
        connectorType: "x",
        authMethod: "external-code",
        sessionTokenHash: "connector-slug-current-build-external-code-token",
        encryptedProviderState:
          "connector-slug-current-build-external-code-state",
        authorizationUrl: "https://example.com/current-build/authorize",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      .returning({
        id: connectorSlugLegacyInsertExternalCodeSessions.id,
      }),
    [
      {
        id: connectorSlugLegacyInsertIds.connector_external_code_sessions,
      },
    ],
  );
  assert.deepEqual(
    await database
      .insert(connectorSlugLegacyInsertUserPermissionGrants)
      .values({
        id: connectorSlugLegacyInsertIds.user_permission_grants,
        orgId: "connector-slug-org",
        userId: "connector-slug-current-build-permission-user",
        agentId: CONNECTOR_SLUG_EXPANSION_AGENT_ID,
        connectorRef: "slack",
        permission: "channels:history",
        action: "allow",
      })
      .returning({
        id: connectorSlugLegacyInsertUserPermissionGrants.id,
      }),
    [{ id: connectorSlugLegacyInsertIds.user_permission_grants }],
  );
}

async function waitForConnectorSlugMigrationLock(
  observer: Client,
  migrationPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await observer.query<{ readonly waiting: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM "pg_catalog"."pg_locks"
          WHERE "pid" = $1
            AND "relation" = 'connectors'::regclass
            AND "mode" = 'AccessExclusiveLock'
            AND NOT "granted"
        ) AS "waiting"
      `,
      [migrationPid],
    );
    if (result.rows[0]?.waiting) {
      return;
    }
    await delay(10);
  }

  throw new Error(
    "Connector slug migration did not wait for the expected ACCESS EXCLUSIVE lock",
  );
}

async function applyConnectorSlugExpansionBehindConcurrentWriter(
  testDbUrl: string,
  connectorId: string,
): Promise<void> {
  const writer = new Client({ connectionString: testDbUrl });
  const migration = new Client({ connectionString: testDbUrl });
  const observer = new Client({ connectionString: testDbUrl });
  await writer.connect();
  await migration.connect();
  await observer.connect();

  let writerTransactionOpen = false;
  let migrationFailure: unknown = null;
  let migrationTask: Promise<void> | null = null;
  try {
    await writer.query("BEGIN");
    writerTransactionOpen = true;
    const lockedConnector = await writer.query(
      `SELECT "id" FROM "connectors" WHERE "id" = $1 FOR UPDATE`,
      [connectorId],
    );
    assert.equal(lockedConnector.rowCount, 1);
    const migrationPidResult = await migration.query<{
      readonly pid: number;
    }>(`SELECT pg_backend_pid() AS "pid"`);
    const migrationPid = migrationPidResult.rows[0]?.pid;
    assert.ok(migrationPid);

    migrationTask = applyMigrationsUpToInTransaction(
      migration,
      CONNECTOR_SLUG_EXPANSION_MIGRATION,
    ).catch((error: unknown) => {
      migrationFailure = error;
    });
    await waitForConnectorSlugMigrationLock(observer, migrationPid);

    await writer.query(
      `
        UPDATE "connectors"
        SET "updated_at" = clock_timestamp()
        WHERE "id" = $1
      `,
      [connectorId],
    );
    await writer.query("COMMIT");
    writerTransactionOpen = false;

    await migrationTask;
    if (migrationFailure !== null) {
      throw migrationFailure;
    }
  } finally {
    if (writerTransactionOpen) {
      await writer.query("ROLLBACK");
    }
    if (migrationTask !== null) {
      await migrationTask;
    }
    await writer.end();
    await migration.end();
    await observer.end();
  }
}

async function validateConnectorSlugExpansion(): Promise<void> {
  console.log(
    "=== Phase 1.6: Validate connector slug expansion compatibility ===\n",
  );
  const testDb = "migration_connector_slug_expansion_test";
  const testDbUrl = createTestDbUrl(testDb);

  await createDatabase(testDb);
  try {
    await runMigrationsUpTo(
      testDbUrl,
      CONNECTOR_SLUG_EXPANSION_PREVIOUS_MIGRATION,
    );
    const client = new Client({ connectionString: testDbUrl });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO "agent_composes" ("id", "user_id", "name", "org_id")
          VALUES ($1, 'connector-slug-owner', 'connector-slug-agent', 'connector-slug-org')
        `,
        [CONNECTOR_SLUG_EXPANSION_AGENT_ID],
      );
      await client.query(
        `
          INSERT INTO "zero_agents" ("id", "org_id", "owner", "name")
          VALUES ($1, 'connector-slug-org', 'connector-slug-owner', 'connector-slug-agent')
        `,
        [CONNECTOR_SLUG_EXPANSION_AGENT_ID],
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
        [CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID],
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
        [CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID],
      );
      await client.query("COMMIT");
      await client.query(
        `
          INSERT INTO "connectors" (
            "id",
            "custom_connector_id",
            "auth_method",
            "storage_version",
            "user_id",
            "org_id"
          )
          VALUES (
            $1,
            $2,
            'oauth2',
            1,
            'connector-slug-custom-user',
            'connector-slug-org'
          )
        `,
        [
          CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTION_ID,
          CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID,
        ],
      );
      await client.query(
        `
          INSERT INTO "connector_oauth_states" (
            "id",
            "state",
            "custom_connector_id",
            "connector_revision",
            "auth_method",
            "user_id",
            "org_id",
            "redirect_uri",
            "expires_at"
          )
          VALUES (
            $1,
            'connector-slug-custom-state',
            $2,
            1,
            'oauth2',
            'connector-slug-custom-user',
            'connector-slug-org',
            'https://example.com/custom/callback',
            '2030-01-01T00:00:00.000Z'
          )
        `,
        [
          CONNECTOR_SLUG_EXPANSION_CUSTOM_OAUTH_STATE_ID,
          CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID,
        ],
      );

      for (const spec of connectorSlugCompatibilitySpecs) {
        const rows = await insertConnectorSlugRow(client, spec, {
          explicitId: spec.originalId,
          legacySlug: spec.originalSlug,
          returnExpandedIdentity: false,
          suffix: `${spec.tableName}-original`,
        });
        assert.equal(rows.length, 1);
      }

      const originalRows = new Map<string, unknown>();
      const legacyColumns = new Map<string, readonly string[]>();
      for (const spec of connectorSlugCompatibilitySpecs) {
        const snapshot = await client.query<{ readonly data: unknown }>(
          `
            SELECT to_jsonb(stored_row) AS "data"
            FROM "${spec.tableName}" AS stored_row
            WHERE "id" = $1
          `,
          [spec.originalId],
        );
        const snapshotRow = requireSingleResultRow(snapshot.rows);
        originalRows.set(spec.tableName, snapshotRow.data);

        const columns = await client.query<{ readonly columnName: string }>(
          `
            SELECT "column_name" AS "columnName"
            FROM "information_schema"."columns"
            WHERE "table_schema" = current_schema()
              AND "table_name" = $1
            ORDER BY "ordinal_position"
          `,
          [spec.tableName],
        );
        legacyColumns.set(
          spec.tableName,
          columns.rows.map((row) => {
            return row.columnName;
          }),
        );
      }

      await validateExpandedBuildAgainstConnectorSlugPredecessor(client);

      await applyConnectorSlugExpansionBehindConcurrentWriter(
        testDbUrl,
        connectorSlugLegacyInsertIds.connectors,
      );

      const customConnection = await client.query<{
        readonly connectorSlug: string | null;
        readonly customConnectorId: string;
        readonly type: string | null;
      }>(
        `
          SELECT
            "type",
            "connector_slug" AS "connectorSlug",
            "custom_connector_id" AS "customConnectorId"
          FROM "connectors"
          WHERE "id" = $1
        `,
        [CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTION_ID],
      );
      assert.deepEqual(requireSingleResultRow(customConnection.rows), {
        connectorSlug: null,
        customConnectorId: CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID,
        type: null,
      });

      const customOauthState = await client.query<{
        readonly connectorRevision: number;
        readonly connectorSlug: string | null;
        readonly customConnectorId: string;
        readonly type: string | null;
      }>(
        `
          SELECT
            "type",
            "connector_slug" AS "connectorSlug",
            "custom_connector_id" AS "customConnectorId",
            "connector_revision" AS "connectorRevision"
          FROM "connector_oauth_states"
          WHERE "id" = $1
        `,
        [CONNECTOR_SLUG_EXPANSION_CUSTOM_OAUTH_STATE_ID],
      );
      assert.deepEqual(requireSingleResultRow(customOauthState.rows), {
        connectorRevision: 1,
        connectorSlug: null,
        customConnectorId: CONNECTOR_SLUG_EXPANSION_CUSTOM_CONNECTOR_ID,
        type: null,
      });

      for (const spec of connectorSlugCompatibilitySpecs) {
        const stored = await client.query<{
          readonly connectorSlug: string;
          readonly data: unknown;
          readonly legacyValue: string;
        }>(
          `
            SELECT
              to_jsonb(stored_row) - 'connector_slug' AS "data",
              "${spec.legacyColumn}" AS "legacyValue",
              "connector_slug" AS "connectorSlug"
            FROM "${spec.tableName}" AS stored_row
            WHERE "id" = $1
          `,
          [spec.originalId],
        );
        const storedRow = requireSingleResultRow(stored.rows);
        assert.deepEqual(storedRow.data, originalRows.get(spec.tableName));
        assert.equal(storedRow.legacyValue, spec.originalSlug);
        assert.equal(storedRow.connectorSlug, spec.originalSlug);

        const currentBuildInsert = await client.query<{
          readonly connectorSlug: string;
          readonly legacyValue: string;
        }>(
          `
            SELECT
              "${spec.legacyColumn}" AS "legacyValue",
              "connector_slug" AS "connectorSlug"
            FROM "${spec.tableName}"
            WHERE "id" = $1
          `,
          [connectorSlugLegacyInsertIds[spec.tableName]],
        );
        assert.deepEqual(requireSingleResultRow(currentBuildInsert.rows), {
          connectorSlug: connectorSlugLegacyInsertValues[spec.tableName],
          legacyValue: connectorSlugLegacyInsertValues[spec.tableName],
        });

        const oldColumns = legacyColumns.get(spec.tableName);
        assert.ok(oldColumns);
        const oldReturning = await client.query<Record<string, unknown>>(
          `
            UPDATE "${spec.tableName}"
            SET "${spec.legacyColumn}" = "${spec.legacyColumn}"
            WHERE "id" = $1
            RETURNING ${oldColumns
              .map((column) => {
                return `"${column}"`;
              })
              .join(", ")}
          `,
          [spec.originalId],
        );
        const oldReturningRow = requireSingleResultRow(oldReturning.rows);
        assert.deepEqual(
          Object.keys(oldReturningRow).sort(),
          [...oldColumns].sort(),
        );

        const legacySlug = `${spec.slugKey}-legacy`;
        const legacyRows = await insertConnectorSlugRow(client, spec, {
          legacySlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-legacy`,
        });
        const legacyRow = requireSingleResultRow(legacyRows);
        assert.equal(legacyRow.legacyValue, legacySlug);
        assert.equal(legacyRow.connectorSlug, legacySlug);

        const canonicalSlug = `${spec.slugKey}-canonical`;
        const canonicalRows = await insertConnectorSlugRow(client, spec, {
          canonicalSlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-canonical`,
        });
        const canonicalRow = requireSingleResultRow(canonicalRows);
        assert.equal(canonicalRow.legacyValue, canonicalSlug);
        assert.equal(canonicalRow.connectorSlug, canonicalSlug);

        const dualSlug = `${spec.slugKey}-dual`;
        const dualRows = await insertConnectorSlugRow(client, spec, {
          canonicalSlug: dualSlug,
          legacySlug: dualSlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-dual`,
        });
        const dualRow = requireSingleResultRow(dualRows);
        assert.equal(dualRow.legacyValue, dualSlug);
        assert.equal(dualRow.connectorSlug, dualSlug);

        const conflictingInsert = buildConnectorSlugInsert(spec, {
          canonicalSlug: `${spec.slugKey}-canonical-conflict`,
          legacySlug: `${spec.slugKey}-legacy-conflict`,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-conflict`,
        });
        await expectDatabaseError(client, {
          code: "P0001",
          messageIncludes: `connector_slug and ${spec.legacyColumn} must match`,
          query: conflictingInsert.query,
          values: conflictingInsert.values,
        });

        const legacyUpdateSlug = `${spec.slugKey}-legacy-update`;
        const legacyUpdate = await client.query<ConnectorSlugIdentityRow>(
          `
            UPDATE "${spec.tableName}"
            SET "${spec.legacyColumn}" = $1
            WHERE "id" = $2
            RETURNING
              "id",
              "${spec.legacyColumn}" AS "legacyValue",
              "connector_slug" AS "connectorSlug"
          `,
          [legacyUpdateSlug, legacyRow.id],
        );
        const legacyUpdateRow = requireSingleResultRow(legacyUpdate.rows);
        assert.equal(legacyUpdateRow.legacyValue, legacyUpdateSlug);
        assert.equal(legacyUpdateRow.connectorSlug, legacyUpdateSlug);

        const canonicalUpdateSlug = `${spec.slugKey}-canonical-update`;
        const canonicalUpdate = await client.query<ConnectorSlugIdentityRow>(
          `
            UPDATE "${spec.tableName}"
            SET "connector_slug" = $1
            WHERE "id" = $2
            RETURNING
              "id",
              "${spec.legacyColumn}" AS "legacyValue",
              "connector_slug" AS "connectorSlug"
          `,
          [canonicalUpdateSlug, legacyRow.id],
        );
        const canonicalUpdateRow = requireSingleResultRow(canonicalUpdate.rows);
        assert.equal(canonicalUpdateRow.legacyValue, canonicalUpdateSlug);
        assert.equal(canonicalUpdateRow.connectorSlug, canonicalUpdateSlug);

        const dualUpdateSlug = `${spec.slugKey}-dual-update`;
        const dualUpdate = await client.query<ConnectorSlugIdentityRow>(
          `
            UPDATE "${spec.tableName}"
            SET "${spec.legacyColumn}" = $1, "connector_slug" = $1
            WHERE "id" = $2
            RETURNING
              "id",
              "${spec.legacyColumn}" AS "legacyValue",
              "connector_slug" AS "connectorSlug"
          `,
          [dualUpdateSlug, legacyRow.id],
        );
        const dualUpdateRow = requireSingleResultRow(dualUpdate.rows);
        assert.equal(dualUpdateRow.legacyValue, dualUpdateSlug);
        assert.equal(dualUpdateRow.connectorSlug, dualUpdateSlug);

        await expectDatabaseError(client, {
          code: "P0001",
          messageIncludes: `connector_slug and ${spec.legacyColumn} must match`,
          query: `
            UPDATE "${spec.tableName}"
            SET
              "${spec.legacyColumn}" = $1,
              "connector_slug" = $2
            WHERE "id" = $3
          `,
          values: [
            `${spec.slugKey}-legacy-update-conflict`,
            `${spec.slugKey}-canonical-update-conflict`,
            legacyRow.id,
          ],
        });

        const unrelatedUpdate = await client.query<ConnectorSlugIdentityRow>(
          `
            UPDATE "${spec.tableName}"
            SET "id" = "id"
            WHERE "id" = $1
            RETURNING
              "id",
              "${spec.legacyColumn}" AS "legacyValue",
              "connector_slug" AS "connectorSlug"
          `,
          [legacyRow.id],
        );
        const unrelatedUpdateRow = requireSingleResultRow(unrelatedUpdate.rows);
        assert.equal(unrelatedUpdateRow.legacyValue, dualUpdateSlug);
        assert.equal(unrelatedUpdateRow.connectorSlug, dualUpdateSlug);

        const upsertSlug = `${spec.slugKey}-upsert`;
        const firstUpsert = await insertConnectorSlugRow(client, spec, {
          legacySlug: upsertSlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-upsert`,
        });
        requireSingleResultRow(firstUpsert);
        const secondUpsert = await insertConnectorSlugRow(client, spec, {
          conflictAction: "update-legacy",
          legacySlug: upsertSlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-upsert`,
        });
        const secondUpsertRow = requireSingleResultRow(secondUpsert);
        assert.equal(secondUpsertRow.connectorSlug, upsertSlug);
        const ignoredConflict = await insertConnectorSlugRow(client, spec, {
          conflictAction: "nothing",
          legacySlug: upsertSlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-upsert`,
        });
        assert.equal(ignoredConflict.length, 0);

        const duplicateInsert = buildConnectorSlugInsert(spec, {
          legacySlug: upsertSlug,
          returnExpandedIdentity: true,
          suffix: `${spec.tableName}-upsert`,
        });
        await expectDatabaseError(client, {
          code: "23505",
          query: duplicateInsert.query,
          values: duplicateInsert.values,
        });

        const oldRead = await client.query<Record<string, unknown>>(
          `
            SELECT ${oldColumns
              .map((column) => {
                return `"${column}"`;
              })
              .join(", ")}
            FROM "${spec.tableName}"
            ORDER BY "${spec.legacyColumn}", "id"
          `,
        );
        assert.ok(oldRead.rows.length >= 5);
        const firstOldReadRow = oldRead.rows[0];
        assert.ok(firstOldReadRow);
        assert.deepEqual(
          Object.keys(firstOldReadRow).sort(),
          [...oldColumns].sort(),
        );

        const deleted = await client.query<{
          readonly id: string;
          readonly legacyValue: string;
        }>(
          `
            DELETE FROM "${spec.tableName}"
            WHERE "id" = $1 AND "${spec.legacyColumn}" = $2
            RETURNING "id", "${spec.legacyColumn}" AS "legacyValue"
          `,
          [dualRow.id, dualSlug],
        );
        const deletedRow = requireSingleResultRow(deleted.rows);
        assert.equal(deletedRow.legacyValue, dualSlug);
      }

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
    } finally {
      await client.end();
    }
  } finally {
    await dropDatabase(testDb);
  }

  console.log(
    "   ✅ Connector slug expansion preserves predecessor inserts, avoids lock-upgrade deadlocks, and enforces mirrored identity\n",
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
    await validateConnectorSlugExpansion();

    await validateStorageArchiveSizeFinalization();
    await validateStorageLegacyTypeContraction();
    await validateLegacyMemoryCleanup();
    await validateSessionStorageBackfill();
    await validateSlackChatThreadRouteBackfill();
    await validateSlackLegacySchemaContraction();
    await validateTeamsThreadSessionContraction();
    await validateOrgPlanEntitlementBackfill();
    await validateModelObservationContractCleanup();
    await validateChatEventTypeBackfillAndContract();
    await validateStructuredPromptDraftBackfill();
    await validateUserMessageBackfillAndContract();
    await validateCanonicalUserMessageRolloutCompatibility();
    await validateCanonicalUserMessageContraction();
    await validateChatEventQueueContraction();
    await validateChatMessageRoleContraction();
    await validateChatEventTableRename();
    await validateChatInputGoalEvent();
    await validateChatEventAssetRefTableRename();
    await validateBrowserResizeStateRolloutCompatibility();
    await validateCurrentBrowserApiBeforeBillingMigration();

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

    await validatePreviousBrowserApiAfterBillingMigration(dbUrl1);
    await validateChatEventSourcesAreAppendOnly(dbUrl1);
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
        "   ✅ Previous browser API can start after billing migration",
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
