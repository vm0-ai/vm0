#!/usr/bin/env tsx
/**
 * Migration Consistency Test - Plan A (Schema Comparison)
 *
 * This script verifies that all migration files match the schema definitions
 * by comparing the final database state.
 *
 * Steps:
 * 1. Create test database and run existing migrations → dump schema A
 * 2. Create test database, regenerate migrations from schema → dump schema B
 * 3. Compare schema A and schema B (should be identical)
 */

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "../src/db/migrations");
const BACKUP_DIR = path.join(__dirname, "../.migrations-backup");

// Database connection details for testing
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = process.env.DB_PORT || "5432";
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "";

function createTestDbUrl(dbName: string): string {
  const auth = DB_PASSWORD ? `${DB_USER}:${DB_PASSWORD}` : DB_USER;
  return `postgresql://${auth}@${DB_HOST}:${DB_PORT}/${dbName}`;
}

function execCommand(cmd: string, env?: Record<string, string>): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
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
  execCommand(`tsx ${path.join(__dirname, "migrate.ts")}`, {
    DATABASE_URL: dbUrl,
  });
}

async function dumpSchema(dbUrl: string): Promise<string> {
  console.log(`📸 Dumping database schema...`);

  // Use pg_dump with options to get a clean, comparable schema
  const output = execCommand(
    `pg_dump "${dbUrl}" --schema-only --no-owner --no-privileges --no-comments --no-tablespaces --no-security-labels --no-subscriptions`,
  );

  // Normalize the output to remove non-deterministic parts
  return normalizeSchema(output);
}

function normalizeSchema(schema: string): string {
  // Remove comments and empty lines
  let normalized = schema
    .split("\n")
    .filter((line) => {
      // Skip comments
      if (line.trim().startsWith("--")) return false;
      // Skip empty lines
      if (line.trim() === "") return false;
      // Skip SET commands
      if (line.trim().startsWith("SET ")) return false;
      // Skip SELECT pg_catalog commands
      if (line.trim().startsWith("SELECT pg_catalog.")) return false;
      return true;
    })
    .join("\n");

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
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
  execCommand("pnpm drizzle-kit generate", {
    cwd: path.join(__dirname, ".."),
  });
}

async function main(): Promise<void> {
  console.log(
    "🧪 Testing Migration Consistency (Plan A - Schema Comparison)\n",
  );

  const TEST_DB_1 = "migration_test_existing";
  const TEST_DB_2 = "migration_test_generated";

  try {
    // Step 1: Test with existing migrations
    console.log("=== Phase 1: Test existing migrations ===\n");
    await createDatabase(TEST_DB_1);
    const dbUrl1 = createTestDbUrl(TEST_DB_1);
    await runMigrations(dbUrl1);
    const schemaFromExisting = await dumpSchema(dbUrl1);
    console.log(`   Schema dump size: ${schemaFromExisting.length} chars\n`);

    // Step 2: Backup and regenerate migrations
    console.log("=== Phase 2: Test regenerated migrations ===\n");
    await backupMigrations();
    await generateFreshMigrations();

    // Step 3: Test with regenerated migrations
    await createDatabase(TEST_DB_2);
    const dbUrl2 = createTestDbUrl(TEST_DB_2);
    await runMigrations(dbUrl2);
    const schemaFromGenerated = await dumpSchema(dbUrl2);
    console.log(`   Schema dump size: ${schemaFromGenerated.length} chars\n`);

    // Step 4: Restore original migrations
    await restoreMigrations();

    // Step 5: Compare schemas
    console.log("=== Phase 3: Compare schemas ===\n");
    if (schemaFromExisting === schemaFromGenerated) {
      console.log("✅ SUCCESS: Schemas are byte-for-byte identical!");
      console.log("   All migrations match the schema definitions perfectly.");

      // Cleanup
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);

      process.exit(0);
    } else {
      console.log("⚠️  Raw schemas differ, running normalized comparison...\n");

      // Save individual schemas for debugging
      const existingFile = path.join(__dirname, "../.schema-existing.sql");
      const generatedFile = path.join(__dirname, "../.schema-generated.sql");

      await fs.writeFile(existingFile, schemaFromExisting);
      await fs.writeFile(generatedFile, schemaFromGenerated);

      console.log(`   Raw schemas saved to:`);
      console.log(`     Existing:  ${existingFile}`);
      console.log(`     Generated: ${generatedFile}`);
      console.log(`   Existing schema: ${schemaFromExisting.length} chars`);
      console.log(`   Generated schema: ${schemaFromGenerated.length} chars\n`);

      // Run normalized comparison
      console.log(
        "=== Phase 4: Normalized comparison (ignoring benign differences) ===\n",
      );
      try {
        execCommand(
          `tsx ${path.join(__dirname, "compare-schemas-normalized.ts")}`,
          {
            DB1_URL: dbUrl1,
            DB2_URL: dbUrl2,
          },
        );

        // If we reach here, normalized comparison succeeded
        console.log("\n✅ SUCCESS: Schemas are functionally equivalent!");
        console.log(
          "   Differences are cosmetic (column order, CHECK constraint names).",
        );
        console.log(
          "   These benign differences do not affect database behavior.",
        );

        // Cleanup
        await dropDatabase(TEST_DB_1);
        await dropDatabase(TEST_DB_2);

        process.exit(0);
      } catch {
        // Normalized comparison failed - real functional differences exist
        console.log("\n❌ FAILURE: Schemas have functional differences!");

        // Try to run diff command for debugging
        try {
          const diffOutput = execCommand(
            `diff -u ${existingFile} ${generatedFile} || true`,
          );
          const diffFile = path.join(__dirname, "../.schema-diff.txt");
          await fs.writeFile(diffFile, diffOutput);
          console.log(`\n   Raw diff saved to: ${diffFile}`);
          console.log(`\n   First 50 lines of diff:\n`);
          console.log(diffOutput.split("\n").slice(0, 50).join("\n"));
        } catch (diffError) {
          console.log(`   Could not generate diff: ${diffError}`);
        }

        // Don't cleanup - leave databases for detailed analysis
        console.log(`\n   💡 Databases preserved for analysis:`);
        console.log(`      ${TEST_DB_1}`);
        console.log(`      ${TEST_DB_2}`);
        console.log(`\n   For detailed analysis, run:`);
        console.log(`     pnpm tsx scripts/compare-schemas-normalized.ts`);
        console.log(`     pnpm tsx scripts/detailed-schema-diff.ts`);

        process.exit(1);
      }
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

main();
