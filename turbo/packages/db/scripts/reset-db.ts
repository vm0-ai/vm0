#!/usr/bin/env tsx

import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

async function resetDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    console.log("Dropping all tables...");
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;

    console.log("Running migrations...");
    await applyPendingMigrations(sql);

    console.log("Database reset complete");
  } finally {
    await sql.end();
  }
}

await resetDatabase();
