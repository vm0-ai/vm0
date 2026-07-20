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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

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

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectAppendOnlyUpdateRejected(
  client: Client,
  args: {
    readonly tableName: "chat_messages" | "chat_thread_events";
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

async function validateChatEventSourcesAreAppendOnly(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate append-only chat event sources ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  let agentComposeId: string | undefined;
  let threadId: string | undefined;
  let messageId: string | undefined;
  let eventId: string | undefined;

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
        INSERT INTO "chat_threads" ("user_id", "agent_compose_id", "title")
        VALUES ('append-only-test-user', $1, 'append-only migration test')
        RETURNING "id"
      `,
      [agentComposeId],
    );
    threadId = thread.rows[0]?.id;
    if (!threadId) {
      throw new Error("Failed to create append-only chat thread fixture");
    }

    const message = await client.query<{ id: string }>(
      `
        INSERT INTO "chat_messages" ("chat_thread_id", "role", "content")
        VALUES ($1, 'user', 'append-only migration test')
        RETURNING "id"
      `,
      [threadId],
    );
    messageId = message.rows[0]?.id;
    if (!messageId) {
      throw new Error("Failed to create append-only chat message fixture");
    }

    const event = await client.query<{ id: string }>(
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
        RETURNING "id"
      `,
      [threadId, agentComposeId],
    );
    eventId = event.rows[0]?.id;
    if (!eventId) {
      throw new Error("Failed to create append-only chat thread event fixture");
    }

    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_messages",
      query: `UPDATE "chat_messages" SET "content" = 'mutated' WHERE "id" = $1`,
      rowId: messageId,
    });
    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_thread_events",
      query: `UPDATE "chat_thread_events" SET "title" = 'mutated' WHERE "id" = $1`,
      rowId: eventId,
    });

    console.log("   ✅ chat_messages rejects UPDATE");
    console.log("   ✅ chat_thread_events rejects UPDATE\n");
  } finally {
    if (eventId) {
      await client.query(`DELETE FROM "chat_thread_events" WHERE "id" = $1`, [
        eventId,
      ]);
    }
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

    // Step 1.5: Validate latest snapshot accuracy (NEW)
    await validateLatestSnapshotAccuracy();

    // Step 1: Test with existing migrations
    console.log("=== Phase 2: Test existing migrations ===\n");
    await createDatabase(TEST_DB_1);
    const dbUrl1 = createTestDbUrl(TEST_DB_1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Migrations applied successfully\n");

    await validateChatEventSourcesAreAppendOnly(dbUrl1);

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
      console.log("   ✅ Chat event source tables reject UPDATE");
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
