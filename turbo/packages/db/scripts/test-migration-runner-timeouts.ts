#!/usr/bin/env tsx

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { Client } from "pg";
import {
  applyPendingMigrations,
  NON_TRANSACTIONAL_MIGRATION_MARKER,
} from "./migration-runner";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}
const DATABASE_URL = process.env.DATABASE_URL;

const testDatabase = `migration_runner_timeouts_${process.pid}_${Date.now()}`;
const fixtureDirectory = await fs.mkdtemp(
  path.join(tmpdir(), "okou-migration-runner-"),
);

async function createTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${testDatabase}"`);
  } finally {
    await client.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${testDatabase}"`);
  } finally {
    await client.end();
  }
}

async function writeMigrationFixture(): Promise<void> {
  const migrationsDirectory = path.join(fixtureDirectory, "src", "migrations");
  await fs.mkdir(path.join(migrationsDirectory, "meta"), { recursive: true });
  await fs.writeFile(
    path.join(migrationsDirectory, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1,
          tag: "0000_transactional_timeouts",
          breakpoints: true,
        },
        {
          idx: 1,
          version: "7",
          when: 2,
          tag: "0001_non_transactional_timeouts",
          breakpoints: true,
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(migrationsDirectory, "0000_transactional_timeouts.sql"),
    `DO $$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '1 second' THEN
    RAISE EXCEPTION 'expected lock_timeout 1s, got %', current_setting('lock_timeout');
  END IF;
  IF current_setting('statement_timeout')::interval <> interval '10 seconds' THEN
    RAISE EXCEPTION 'expected statement_timeout 10s, got %', current_setting('statement_timeout');
  END IF;
END
$$;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '3 seconds' THEN
    RAISE EXCEPTION 'expected overridden lock_timeout 3s, got %', current_setting('lock_timeout');
  END IF;
  IF current_setting('statement_timeout')::interval <> interval '30 seconds' THEN
    RAISE EXCEPTION 'expected overridden statement_timeout 30s, got %', current_setting('statement_timeout');
  END IF;
END
$$;
`,
  );
  await fs.writeFile(
    path.join(migrationsDirectory, "0001_non_transactional_timeouts.sql"),
    `${NON_TRANSACTIONAL_MIGRATION_MARKER}
DO $$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '7 seconds' THEN
    RAISE EXCEPTION 'expected session lock_timeout 7s, got %', current_setting('lock_timeout');
  END IF;
  IF current_setting('statement_timeout')::interval <> interval '70 seconds' THEN
    RAISE EXCEPTION 'expected session statement_timeout 70s, got %', current_setting('statement_timeout');
  END IF;
END
$$;
`,
  );
}

async function validateMigrationRunnerTimeouts(): Promise<void> {
  const testDatabaseUrl = new URL(DATABASE_URL);
  testDatabaseUrl.pathname = `/${testDatabase}`;
  testDatabaseUrl.searchParams.set(
    "options",
    "-c lock_timeout=7s -c statement_timeout=70s",
  );

  const originalDirectory = process.cwd();
  const sql = postgres(testDatabaseUrl.toString(), { max: 1 });
  process.chdir(fixtureDirectory);
  try {
    await applyPendingMigrations(sql);
    const ledger = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM "drizzle"."__drizzle_migrations"
    `;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.count, 2);
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}

try {
  await writeMigrationFixture();
  await createTestDatabase();
  try {
    await validateMigrationRunnerTimeouts();
  } finally {
    await dropTestDatabase();
  }
} finally {
  await fs.rm(fixtureDirectory, { recursive: true, force: true });
}

console.log("Migration runner timeout defaults validated");
