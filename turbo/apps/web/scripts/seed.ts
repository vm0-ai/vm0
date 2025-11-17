#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createHash } from "crypto";
import { apiKeys } from "../src/db/schema/api-key";

/**
 * Hash API key using SHA-256
 */
function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Seed database with initial API key
 */
async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);

  try {
    const apiKey = "dev-key-123";
    const keyHash = hashApiKey(apiKey);

    await db.insert(apiKeys).values({
      keyHash,
      name: "Development Key",
    });

    console.log("✅ Seeded API key: dev-key-123");
  } finally {
    await sql.end();
  }
}

await seed();
