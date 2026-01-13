#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log(
      "No DATABASE_URL set, skipping migrations (PGlite auto-migrates)",
    );
    return;
  }

  console.log("Running migrations with PostgreSQL...");
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    await migrate(db, {
      migrationsFolder: DRIZZLE_MIGRATE_OUT,
    });
    console.log("Migrations complete");
  } finally {
    await sql.end();
  }
}

await runMigrations();
