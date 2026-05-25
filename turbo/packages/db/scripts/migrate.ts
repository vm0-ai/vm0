#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
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
