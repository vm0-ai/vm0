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
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(dirname, "..");
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, "src/migrations");
const BACKUP_DIR = path.join(dirname, "../.migrations-backup");

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

async function readLegacySecretValue(
  client: Client,
  args: {
    connectorId: string;
    userId: string;
  },
): Promise<string | undefined> {
  const value = await client.query<{ encrypted_value: string }>(
    `
    SELECT encrypted_value
    FROM org_custom_connector_values
    WHERE connector_id = $1
      AND user_id = $2
      AND kind = 'secret'
      AND key = 'secret'
    `,
    [args.connectorId, args.userId],
  );
  return value.rows[0]?.encrypted_value;
}

async function seedCustomConnectorLegacyBackfillRows(
  dbUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const declaredSecretConnectorId = "00000000-0000-0000-0000-000000005540";
    const legacyEmptyFieldsConnectorId = "00000000-0000-0000-0000-000000005541";
    const undeclaredSecretConnectorId = "00000000-0000-0000-0000-000000005542";
    const orgId = "org_custom_connector_backfill_bridge";
    const userId = "user_custom_connector_backfill_bridge";

    await client.query(
      `
      INSERT INTO org_custom_connectors (
        id,
        org_id,
        slug,
        display_name,
        prefixes,
        header_name,
        header_template,
        prefix_templates,
        fields,
        header_injections,
        query_injections,
        created_by
      )
      VALUES
        (
          $1,
          $4,
          'backfill-declared-secret',
          'Backfill Declared Secret',
          '["https://backfill-declared-secret.example.test/"]'::jsonb,
          'Authorization',
          'Bearer {{secret}}',
          '["https://backfill-declared-secret.example.test/"]'::jsonb,
          '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb,
          '[]'::jsonb,
          $5
        ),
        (
          $2,
          $4,
          'backfill-empty-fields',
          'Backfill Empty Fields',
          '["https://backfill-empty-fields.example.test/"]'::jsonb,
          'Authorization',
          'Bearer {{secret}}',
          '[]'::jsonb,
          '[]'::jsonb,
          '[]'::jsonb,
          '[]'::jsonb,
          $5
        ),
        (
          $3,
          $4,
          'backfill-no-secret',
          'Backfill No Secret',
          '["https://backfill-no-secret.example.test/"]'::jsonb,
          'X-Tenant',
          '{{variables.tenant}}',
          '["https://backfill-no-secret.example.test/"]'::jsonb,
          '[{"key":"tenant","label":"Tenant","kind":"variable","required":true}]'::jsonb,
          '[]'::jsonb,
          '[{"name":"tenant","valueTemplate":"{{variables.tenant}}"}]'::jsonb,
          $5
        )
      `,
      [
        declaredSecretConnectorId,
        legacyEmptyFieldsConnectorId,
        undeclaredSecretConnectorId,
        orgId,
        userId,
      ],
    );

    await client.query(
      `
      INSERT INTO org_custom_connector_secrets (
        connector_id,
        user_id,
        org_id,
        encrypted_value,
        created_at,
        updated_at
      )
      VALUES
        ($1, $4, $5, 'backfill-declared-secret', '2026-01-01', '2026-01-01'),
        ($2, $4, $5, 'backfill-empty-fields', '2026-01-01', '2026-01-01'),
        ($3, $4, $5, 'backfill-undeclared-secret', '2026-01-01', '2026-01-01')
      `,
      [
        declaredSecretConnectorId,
        legacyEmptyFieldsConnectorId,
        undeclaredSecretConnectorId,
        userId,
        orgId,
      ],
    );

    await client.query(
      `
      INSERT INTO org_custom_connector_values (
        connector_id,
        user_id,
        org_id,
        kind,
        key,
        encrypted_value,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'secret',
        'secret',
        'stale-undeclared-secret',
        '2026-01-01',
        '2026-01-01'
      )
      `,
      [undeclaredSecretConnectorId, userId, orgId],
    );
  } finally {
    await client.end();
  }
}

async function validateCustomConnectorLegacyBackfillRows(
  dbUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const declaredSecretConnectorId = "00000000-0000-0000-0000-000000005540";
    const legacyEmptyFieldsConnectorId = "00000000-0000-0000-0000-000000005541";
    const undeclaredSecretConnectorId = "00000000-0000-0000-0000-000000005542";
    const userId = "user_custom_connector_backfill_bridge";

    const declaredSecretValue = await readLegacySecretValue(client, {
      connectorId: declaredSecretConnectorId,
      userId,
    });
    if (declaredSecretValue !== "backfill-declared-secret") {
      throw new Error(
        "Legacy custom connector backfill skipped a declared secret field",
      );
    }

    const emptyFieldsValue = await readLegacySecretValue(client, {
      connectorId: legacyEmptyFieldsConnectorId,
      userId,
    });
    if (emptyFieldsValue !== "backfill-empty-fields") {
      throw new Error(
        "Legacy custom connector backfill skipped an empty-fields connector",
      );
    }

    const undeclaredSecretValue = await readLegacySecretValue(client, {
      connectorId: undeclaredSecretConnectorId,
      userId,
    });
    if (undeclaredSecretValue !== undefined) {
      throw new Error(
        "Legacy custom connector backfill imported an undeclared secret field",
      );
    }
  } finally {
    await client.end();
  }
}

async function validateCustomConnectorLegacySecretBridge(
  dbUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const connectorId = "00000000-0000-0000-0000-000000005550";
    const undeclaredSecretConnectorId = "00000000-0000-0000-0000-000000005551";
    const orgId = "org_custom_connector_migration_bridge";
    const primaryUserId = "user_custom_connector_migration_bridge_primary";
    const deleteUserId = "user_custom_connector_migration_bridge_delete";

    await client.query(
      `
      INSERT INTO org_custom_connectors (
        id,
        org_id,
        slug,
        display_name,
        prefixes,
        header_name,
        header_template,
        prefix_templates,
        fields,
        header_injections,
        query_injections,
        created_by
      )
      VALUES (
        $1,
        $2,
        'migration-bridge',
        'Migration Bridge',
        '["https://migration-bridge.example.test/"]'::jsonb,
        'Authorization',
        'Bearer {{secret}}',
        '["https://migration-bridge.example.test/"]'::jsonb,
        '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb,
        '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb,
        '[]'::jsonb,
        $3
      )
      `,
      [connectorId, orgId, primaryUserId],
    );

    await client.query(
      `
      INSERT INTO org_custom_connectors (
        id,
        org_id,
        slug,
        display_name,
        prefixes,
        header_name,
        header_template,
        prefix_templates,
        fields,
        header_injections,
        query_injections,
        created_by
      )
      VALUES (
        $1,
        $2,
        'migration-bridge-no-secret',
        'Migration Bridge No Secret',
        '["https://migration-bridge-no-secret.example.test/"]'::jsonb,
        'X-Tenant',
        '{{variables.tenant}}',
        '["https://migration-bridge-no-secret.example.test/"]'::jsonb,
        '[{"key":"tenant","label":"Tenant","kind":"variable","required":true}]'::jsonb,
        '[]'::jsonb,
        '[{"name":"tenant","valueTemplate":"{{variables.tenant}}"}]'::jsonb,
        $3
      )
      `,
      [undeclaredSecretConnectorId, orgId, primaryUserId],
    );

    await client.query(
      `
      INSERT INTO org_custom_connector_secrets (
        connector_id,
        user_id,
        org_id,
        encrypted_value,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'legacy-insert', '2026-01-01', '2026-01-01')
      `,
      [connectorId, primaryUserId, orgId],
    );

    let value = await client.query<{ encrypted_value: string }>(
      `
      SELECT encrypted_value
      FROM org_custom_connector_values
      WHERE connector_id = $1
        AND user_id = $2
        AND kind = 'secret'
        AND key = 'secret'
      `,
      [connectorId, primaryUserId],
    );
    if (value.rows[0]?.encrypted_value !== "legacy-insert") {
      throw new Error("Legacy custom connector insert did not sync to values");
    }

    await client.query(
      `
      INSERT INTO org_custom_connector_secrets (
        connector_id,
        user_id,
        org_id,
        encrypted_value,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'legacy-undeclared', '2026-01-01', '2026-01-01')
      `,
      [undeclaredSecretConnectorId, primaryUserId, orgId],
    );

    const undeclared = await client.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM org_custom_connector_values
      WHERE connector_id = $1
        AND user_id = $2
        AND kind = 'secret'
        AND key = 'secret'
      `,
      [undeclaredSecretConnectorId, primaryUserId],
    );
    if (undeclared.rows[0]?.count !== "0") {
      throw new Error(
        "Legacy custom connector secret synced for an undeclared field",
      );
    }

    await client.query(
      `
      UPDATE org_custom_connector_secrets
      SET encrypted_value = 'legacy-update',
          updated_at = '2026-01-02'
      WHERE connector_id = $1
        AND user_id = $2
      `,
      [connectorId, primaryUserId],
    );

    value = await client.query<{ encrypted_value: string }>(
      `
      SELECT encrypted_value
      FROM org_custom_connector_values
      WHERE connector_id = $1
        AND user_id = $2
        AND kind = 'secret'
        AND key = 'secret'
      `,
      [connectorId, primaryUserId],
    );
    if (value.rows[0]?.encrypted_value !== "legacy-update") {
      throw new Error("Legacy custom connector update did not sync to values");
    }

    await client.query(
      `
      UPDATE org_custom_connector_values
      SET encrypted_value = 'direct-new-api-write',
          updated_at = '2026-01-03'
      WHERE connector_id = $1
        AND user_id = $2
        AND kind = 'secret'
        AND key = 'secret'
      `,
      [connectorId, primaryUserId],
    );
    await client.query(
      `
      DELETE FROM org_custom_connector_secrets
      WHERE connector_id = $1
        AND user_id = $2
      `,
      [connectorId, primaryUserId],
    );

    value = await client.query<{ encrypted_value: string }>(
      `
      SELECT encrypted_value
      FROM org_custom_connector_values
      WHERE connector_id = $1
        AND user_id = $2
        AND kind = 'secret'
        AND key = 'secret'
      `,
      [connectorId, primaryUserId],
    );
    if (value.rows[0]?.encrypted_value !== "direct-new-api-write") {
      throw new Error("Legacy custom connector delete removed a new value");
    }

    await client.query(
      `
      INSERT INTO org_custom_connector_secrets (
        connector_id,
        user_id,
        org_id,
        encrypted_value,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'legacy-delete', '2026-01-04', '2026-01-04')
      `,
      [connectorId, deleteUserId, orgId],
    );
    await client.query(
      `
      DELETE FROM org_custom_connector_secrets
      WHERE connector_id = $1
        AND user_id = $2
      `,
      [connectorId, deleteUserId],
    );

    const deleted = await client.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM org_custom_connector_values
      WHERE connector_id = $1
        AND user_id = $2
        AND kind = 'secret'
        AND key = 'secret'
      `,
      [connectorId, deleteUserId],
    );
    if (deleted.rows[0]?.count !== "0") {
      throw new Error(
        "Legacy custom connector delete did not remove the value",
      );
    }
  } finally {
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
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.cp(BACKUP_DIR, MIGRATIONS_DIR, { recursive: true });
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
}

async function generateFreshMigrations(): Promise<void> {
  console.log("🔨 Generating fresh migrations from schema...");

  // Delete existing migrations
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });

  // Generate new migrations (non-interactive)
  execCommand("pnpm drizzle-kit generate", { cwd: PACKAGE_DIR });
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

async function runMigrationsUpTo(
  dbUrl: string,
  upToIdx: number,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
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
  } finally {
    await client.end();
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
  const customConnectorBridgeEntry = entries.find((entry) => {
    return entry.tag === "0551_backfill_custom_connector_values";
  });
  if (!customConnectorBridgeEntry) {
    throw new Error("Missing custom connector bridge migration entry");
  }

  console.log(`   Validating latest snapshot (migration ${latestIdx})\n`);

  // Create clean test database
  await createDatabase(TEST_DB);
  const dbUrl = createTestDbUrl(TEST_DB);

  try {
    await runMigrationsUpTo(dbUrl, customConnectorBridgeEntry.idx - 1);
    await seedCustomConnectorLegacyBackfillRows(dbUrl);
    await runMigrationsUpTo(dbUrl, customConnectorBridgeEntry.idx);
    await validateCustomConnectorLegacyBackfillRows(dbUrl);
    console.log("   ✅ Custom connector legacy secret backfill works");

    // Apply remaining migrations
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

    await validateCustomConnectorLegacySecretBridge(dbUrl);
    console.log("   ✅ Custom connector legacy secret bridge works");
  } finally {
    await dropDatabase(TEST_DB);
  }

  console.log();
}

async function main(): Promise<void> {
  console.log("🧪 Testing Migration Consistency (Schema Comparison)\n");

  const TEST_DB_1 = "migration_test_existing";
  const TEST_DB_2 = "migration_test_generated";

  try {
    // Step 0: Validate snapshot files
    await validateSnapshotFiles();

    // Step 0.5: Validate timestamp ordering
    await validateTimestampOrdering();

    // Step 1.5: Validate latest snapshot accuracy (NEW)
    await validateLatestSnapshotAccuracy();

    // Step 1: Test with existing migrations
    console.log("=== Phase 2: Test existing migrations ===\n");
    await createDatabase(TEST_DB_1);
    const dbUrl1 = createTestDbUrl(TEST_DB_1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Migrations applied successfully\n");

    // Step 2: Backup and regenerate migrations
    console.log("=== Phase 3: Test regenerated migrations ===\n");
    await backupMigrations();
    await generateFreshMigrations();

    // Step 3: Test with regenerated migrations
    await createDatabase(TEST_DB_2);
    const dbUrl2 = createTestDbUrl(TEST_DB_2);
    await runMigrations(dbUrl2);
    console.log("   ✅ Fresh migrations applied successfully\n");

    // Step 4: Restore original migrations
    await restoreMigrations();

    // Step 5: Run normalized comparison (using pg library)
    console.log("=== Phase 4: Normalized schema comparison ===\n");
    const comparisonPassed = await runNormalizedComparison(dbUrl1, dbUrl2);

    if (comparisonPassed) {
      console.log("\n✅ SUCCESS: All validations passed!");
      console.log("   ✅ Snapshot count matches migration count");
      console.log("   ✅ Snapshot chain is intact (id/prevId references)");
      console.log("   ✅ Journal timestamps are strictly increasing");
      console.log("   ✅ Latest snapshot accurately reflects final DB state");
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
      await restoreMigrations();
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
