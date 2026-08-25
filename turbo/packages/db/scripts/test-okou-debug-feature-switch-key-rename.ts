import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0976_contract_legacy_agent_run_model_key";
const renameMigration = "0977_rename_zero_debug_feature_switch_key";
const testDatabase = "migration_okou_debug_feature_switch_key_rename";
const orgId = "org_okou_debug_rename";
const orgSentinelUserId = "__org__";

interface SwitchesRow {
  readonly switches: Record<string, boolean>;
  readonly updatedAt: Date;
  readonly userId: string;
}

async function seedFeatureSwitchFixture(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "user_feature_switches" ("org_id", "user_id", "switches", "updated_at")
      VALUES
        ($1, 'user_enabled', '{"zeroDebug": true, "lab": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_disabled', '{"zeroDebug": false}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_untouched', '{"lab": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_empty', '{}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, $2, '{"zeroDebug": true, "piLoop": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00')
    `,
    [orgId, orgSentinelUserId],
  );
}

async function readFeatureSwitchRows(
  client: Client,
): Promise<readonly SwitchesRow[]> {
  const result = await client.query<SwitchesRow>(
    `
      SELECT "user_id" AS "userId", "switches", "updated_at" AS "updatedAt"
      FROM "user_feature_switches"
      WHERE "org_id" = $1
      ORDER BY "user_id"
    `,
    [orgId],
  );
  return result.rows;
}

function rowByUserId(
  rows: readonly SwitchesRow[],
  userId: string,
): SwitchesRow {
  const row = rows.find((candidate) => {
    return candidate.userId === userId;
  });
  assert.ok(row, `missing feature switch row for ${userId}`);
  return row;
}

function assertRenamedState(rows: readonly SwitchesRow[]): void {
  assert.deepEqual(rowByUserId(rows, "user_enabled").switches, {
    okouDebug: true,
    lab: true,
  });
  assert.deepEqual(rowByUserId(rows, "user_disabled").switches, {
    okouDebug: false,
  });
  assert.deepEqual(rowByUserId(rows, orgSentinelUserId).switches, {
    okouDebug: true,
    piLoop: true,
  });

  const untouched = rowByUserId(rows, "user_untouched");
  assert.deepEqual(untouched.switches, { lab: true });
  assert.equal(
    untouched.updatedAt.getTime(),
    Date.parse("2026-01-01T00:00:00"),
  );

  const empty = rowByUserId(rows, "user_empty");
  assert.deepEqual(empty.switches, {});
  assert.equal(empty.updatedAt.getTime(), Date.parse("2026-01-01T00:00:00"));
}

export async function validateOkouDebugFeatureSwitchKeyRename(): Promise<void> {
  console.log("=== Validate okouDebug feature switch key rename ===\n");

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await seedFeatureSwitchFixture(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      renameMigration,
    );

    const migratedRows = await readFeatureSwitchRows(client);
    assertRenamedState(migratedRows);

    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${renameMigration}.sql`),
      "utf8",
    );
    await client.query(migrationSql);
    const rerunRows = await readFeatureSwitchRows(client);
    assertRenamedState(rerunRows);
    assert.deepEqual(
      rerunRows.map((row) => {
        return row.updatedAt.getTime();
      }),
      migratedRows.map((row) => {
        return row.updatedAt.getTime();
      }),
      "rerunning the rename must not rewrite any row",
    );

    console.log("   ✅ enabled overrides move to the okouDebug key");
    console.log("   ✅ disabled overrides keep their false value");
    console.log("   ✅ org-scoped sentinel rows are migrated");
    console.log("   ✅ rows without the legacy key are left untouched");
    console.log("   ✅ rerunning the rename is a no-op\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateOkouDebugFeatureSwitchKeyRename().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
