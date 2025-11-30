#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  // Debug: Print migration folder contents
  console.log("Migration folder:", DRIZZLE_MIGRATE_OUT);
  const journalPath = path.join(DRIZZLE_MIGRATE_OUT, "meta", "_journal.json");

  // List all SQL files in migration folder
  const sqlFiles = fs
    .readdirSync(DRIZZLE_MIGRATE_OUT)
    .filter((f) => f.endsWith(".sql"));
  console.log("SQL files in folder:", sqlFiles.length);
  console.log("Last 3 SQL files:", sqlFiles.slice(-3));

  // Check if migration 0025 exists and compute its hash
  const migration0025Path = path.join(
    DRIZZLE_MIGRATE_OUT,
    "0025_add_blobs_table.sql",
  );
  if (fs.existsSync(migration0025Path)) {
    const content = fs.readFileSync(migration0025Path, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    console.log("Migration 0025 exists, SHA256 hash:", hash);
    console.log("Migration 0025 content length:", content.length);
  } else {
    console.log("WARNING: Migration 0025 file does NOT exist!");
  }

  if (fs.existsSync(journalPath)) {
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    console.log("Journal entries:", journal.entries.length);
    console.log(
      "Last 3 migrations:",
      journal.entries.slice(-3).map((e: { tag: string }) => e.tag),
    );
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);

  try {
    // Debug: Check what's in __drizzle_migrations (if table exists)
    try {
      const dbMigrations = await sql`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 5
      `;
      console.log(
        "Last 5 DB migrations:",
        dbMigrations.map((m) => m.hash?.substring(0, 16) + "..."),
      );

      const countResult =
        await sql`SELECT COUNT(*) as count FROM drizzle.__drizzle_migrations`;
      console.log("Total DB migrations:", countResult[0]?.count);

      // Show ALL migration hashes to see what's been applied
      const allHashes = await sql`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
      `;
      console.log(
        "All DB migration hashes:",
        allHashes.map((m) => m.hash?.substring(0, 20) + "..."),
      );
    } catch {
      console.log("DB migrations table does not exist yet (fresh database)");
    }

    console.log("Running migrate()...");
    await migrate(db, {
      migrationsFolder: DRIZZLE_MIGRATE_OUT,
    });
    console.log("migrate() completed");

    // Check count after migration
    try {
      const countAfter =
        await sql`SELECT COUNT(*) as count FROM drizzle.__drizzle_migrations`;
      console.log("Total DB migrations after migrate():", countAfter[0]?.count);

      // Check if blobs table exists now
      const tablesResult = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'blobs'
      `;
      console.log(
        "Blobs table exists:",
        tablesResult.length > 0 ? "YES" : "NO",
      );
    } catch (e) {
      console.log("Error checking post-migration state:", e);
    }
  } finally {
    await sql.end();
  }
}

await runMigrations();
