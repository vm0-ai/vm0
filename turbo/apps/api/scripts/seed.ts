#!/usr/bin/env tsx

import postgres from "postgres";

/**
 * Seed database with initial data
 */
async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    // Add seed data here if needed
    console.log("✅ Database seeding completed");
  } finally {
    await sql.end();
  }
}

await seed();
