#!/usr/bin/env tsx

import postgres from "postgres";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    const result = await sql`
      SELECT id, slug, type, owner_id, created_at 
      FROM scopes 
      WHERE owner_id = 'user_37Yl6UOYNzKBLhFpS6HXLSNM5MQ'
      ORDER BY created_at DESC
    `;
    console.log("Existing scopes:", JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

await main();
