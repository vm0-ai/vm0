#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log("No DATABASE_URL set, skipping seeding (PGlite is in-memory)");
    return;
  }

  console.log("Seeding with PostgreSQL...");
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  void db; // Placeholder for future seed operations

  try {
    // Add seed data here if needed
    console.log("✅ Database seeding completed");
  } finally {
    await sql.end();
  }
}

await seed();
