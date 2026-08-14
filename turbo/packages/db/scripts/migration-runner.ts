import { readMigrationFiles } from "drizzle-orm/migrator";
import type postgres from "postgres";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

type DbMigration = {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string | number | null;
};

export const NON_TRANSACTIONAL_MIGRATION_MARKER = "-- vm0:non-transactional";

// Migration 0924 shipped before its production-scale catalog preflight proved
// that the single DO statement can need more than its original 10-second
// budget. Migration files are immutable, so scope the recovery to the exact
// published hash: extend only the preflight, then restore 10 seconds before
// the plain DROP TABLE statement.
const PUBLISHED_MIGRATION_STATEMENT_TIMEOUT_OVERRIDES: ReadonlyMap<
  string,
  ReadonlyMap<number, string>
> = new Map([
  [
    "2320f87e1ef46ae844f5a120a918f694bd9469a96048298ea7e57d1ba090b516",
    new Map([
      [2, "60s"],
      [3, "10s"],
    ]),
  ],
]);

export async function applyPendingMigrations(sql: postgres.Sql): Promise<void> {
  const migrations = readMigrationFiles({
    migrationsFolder: DRIZZLE_MIGRATE_OUT,
  });

  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const dbMigrations = await sql<DbMigration[]>`
    SELECT id, hash, created_at
    FROM "drizzle"."__drizzle_migrations"
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const lastDbMigration = dbMigrations[0];

  for (const migration of migrations) {
    if (
      lastDbMigration &&
      Number(lastDbMigration.created_at) >= migration.folderMillis
    ) {
      continue;
    }

    if (
      migration.sql.some((statement) => {
        return statement.includes(NON_TRANSACTIONAL_MIGRATION_MARKER);
      })
    ) {
      for (const statement of migration.sql) {
        if (statement.trim().length === 0) {
          continue;
        }
        await sql.unsafe(statement);
      }

      await sql`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${migration.hash}, ${migration.folderMillis})
      `;
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL lock_timeout = '1s'`;
      await transaction`SET LOCAL statement_timeout = '10s'`;

      const statementTimeoutOverrides =
        PUBLISHED_MIGRATION_STATEMENT_TIMEOUT_OVERRIDES.get(migration.hash);

      for (const [statementIndex, statement] of migration.sql.entries()) {
        if (statement.trim().length === 0) {
          continue;
        }

        const statementTimeoutOverride =
          statementTimeoutOverrides?.get(statementIndex);
        if (statementTimeoutOverride) {
          await transaction`
            SELECT set_config(
              'statement_timeout',
              ${statementTimeoutOverride},
              true
            )
          `;
        }
        await transaction.unsafe(statement);
      }

      await transaction`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${migration.hash}, ${migration.folderMillis})
      `;
    });
  }
}
