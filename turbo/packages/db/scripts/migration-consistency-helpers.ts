import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import { NON_TRANSACTIONAL_MIGRATION_MARKER } from "./migration-runner";

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

export async function applyMigrationsFromDirectoryUpToTag(
  client: Client,
  migrationsDirectory: string,
  upToTag: string,
): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const journalPath = path.join(migrationsDirectory, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  const upToEntry = journal.entries.find((entry) => {
    return entry.tag === upToTag;
  });
  if (!upToEntry) {
    throw new Error(
      `Migration tag "${upToTag}" is absent from meta/_journal.json because that migration has been squashed. This transition validator is expired and should be deleted.`,
    );
  }

  for (const entry of journal.entries) {
    if (entry.idx > upToEntry.idx) break;

    const sqlFile = path.join(migrationsDirectory, `${entry.tag}.sql`);
    const sql = await fs.readFile(sqlFile, "utf-8");
    const result = await client.query(
      `SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`,
      [entry.tag],
    );
    if (result.rows.length > 0) continue;

    if (sql.includes(NON_TRANSACTIONAL_MIGRATION_MARKER)) {
      const statements = sql
        .split("--> statement-breakpoint")
        .map((statement) => {
          return statement.trim();
        })
        .filter((statement) => {
          return statement.length > 0;
        });
      for (const statement of statements) {
        await client.query(statement);
      }
    } else {
      await client.query(sql);
    }
    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      [entry.tag, entry.when],
    );
  }
}
