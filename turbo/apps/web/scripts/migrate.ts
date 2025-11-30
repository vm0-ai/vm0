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
    // Debug: Check migrations table before
    const before = await sql`
      SELECT COUNT(*) as count FROM drizzle.__drizzle_migrations
    `.catch(() => [{ count: "table not exists" }]);
    console.log("Migrations before:", before[0]?.count);

    await migrate(db, {
      migrationsFolder: DRIZZLE_MIGRATE_OUT,
    });

    // Debug: Check migrations table after and verify blobs table
    const after = await sql`
      SELECT COUNT(*) as count FROM drizzle.__drizzle_migrations
    `;
    console.log("Migrations after:", after[0]?.count);

    const blobsExists = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'blobs'
      ) as exists
    `;
    console.log("Blobs table exists:", blobsExists[0]?.exists);
  } finally {
    await sql.end();
  }
}

await runMigrations();
