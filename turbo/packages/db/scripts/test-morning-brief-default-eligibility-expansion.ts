import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1055_keen_venus";
const eligibilityMigration = "1056_little_johnny_storm";
const testDatabase = "migration_morning_brief_default_eligibility";
const existingMemberCount = 6060;

export async function validateMorningBriefDefaultEligibilityExpansion(): Promise<void> {
  console.log("=== Validate Morning Brief default eligibility expansion ===\n");

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
    await client.query(
      `
        INSERT INTO "org_members_metadata" ("org_id", "user_id")
        SELECT
          'org_existing_' || member_number,
          'user_existing_' || member_number
        FROM generate_series(1, $1::integer) AS member_number
      `,
      [existingMemberCount],
    );

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      eligibilityMigration,
    );

    const rows = await client.query<{
      total: string;
      eligible: string;
    }>(`
      SELECT
        COUNT(*) AS "total",
        COUNT("morning_brief_default_eligible_at") AS "eligible"
      FROM "org_members_metadata"
      WHERE "org_id" LIKE 'org_existing_%'
    `);
    assert.deepEqual(rows.rows, [
      { total: String(existingMemberCount), eligible: "0" },
    ]);

    const columns = await client.query<{
      isNullable: string;
      columnDefault: string | null;
    }>(`
      SELECT
        "is_nullable" AS "isNullable",
        "column_default" AS "columnDefault"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'org_members_metadata'
        AND "column_name" = 'morning_brief_default_eligible_at'
    `);
    assert.deepEqual(columns.rows, [
      { isNullable: "YES", columnDefault: null },
    ]);

    await client.query(`
      INSERT INTO "org_members_metadata" ("org_id", "user_id")
      VALUES ('org_new_without_eligibility', 'user_new_without_eligibility')
    `);
    const newRow = await client.query<{ eligibleAt: Date | null }>(`
      SELECT
        "morning_brief_default_eligible_at" AS "eligibleAt"
      FROM "org_members_metadata"
      WHERE "org_id" = 'org_new_without_eligibility'
        AND "user_id" = 'user_new_without_eligibility'
    `);
    assert.deepEqual(newRow.rows, [{ eligibleAt: null }]);

    console.log(
      `   ✅ all ${existingMemberCount} existing rows remain ineligible`,
    );
    console.log("   ✅ eligibility is nullable with no database default\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateMorningBriefDefaultEligibilityExpansion().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
