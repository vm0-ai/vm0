#!/usr/bin/env tsx

import postgres from "postgres";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    console.log("Testing database connection...");
    const result = await sql`SELECT NOW() as time, version() as version`;
    console.log("✅ Database connection successful!");
    console.log("Time:", result[0].time);
    console.log("Version:", result[0].version);

    console.log("\nTesting scopes table query...");
    const scopes = await sql`
      SELECT id, slug, type, owner_id
      FROM scopes 
      WHERE owner_id = 'user_37Yl6UOYNzKBLhFpS6HXLSNM5MQ' AND type = 'personal'
      LIMIT 1
    `;
    console.log("✅ Query successful!");
    console.log("Result:", scopes[0]);
  } catch (error) {
    console.error("❌ Error:", error);
    throw error;
  } finally {
    await sql.end();
  }
}

await main();
