#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as fs from "node:fs";
import * as path from "node:path";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  // Debug: Print migration folder contents
  console.log("Migration folder:", DRIZZLE_MIGRATE_OUT);
  const journalPath = path.join(DRIZZLE_MIGRATE_OUT, "meta", "_journal.json");
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
    } catch {
      console.log("DB migrations table does not exist yet (fresh database)");
    }

    await migrate(db, {
      migrationsFolder: DRIZZLE_MIGRATE_OUT,
    });
  } finally {
    await sql.end();
  }
}

await runMigrations();
