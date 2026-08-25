import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0984_rich_hemingway";
const backfillMigration = "0986_backfill_official_slack_installation_brand";
const testDatabase = "migration_slack_official_brand_backfill";

interface InstallationBrandRow {
  readonly publicBrand: string;
  readonly slackWorkspaceId: string;
}

async function readInstallationBrands(
  client: Client,
): Promise<readonly InstallationBrandRow[]> {
  const result = await client.query<InstallationBrandRow>(`
    SELECT
      "slack_workspace_id" AS "slackWorkspaceId",
      "public_brand" AS "publicBrand"
    FROM "slack_org_installations"
    WHERE "slack_workspace_id" LIKE 'T_SLACK_BRAND_%'
    ORDER BY "slack_workspace_id"
  `);
  return result.rows;
}

export async function validateSlackOfficialBrandMigration(): Promise<void> {
  console.log("=== Validate official Slack installation brand migration ===\n");

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
    await client.query(`
      INSERT INTO "slack_org_installations" (
        "slack_workspace_id",
        "encrypted_bot_token",
        "bot_user_id",
        "public_brand"
      )
      VALUES (
        'T_SLACK_BRAND_EXISTING',
        'encrypted-existing-token',
        'U_SLACK_BRAND_EXISTING',
        'vm0'
      )
    `);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      backfillMigration,
    );

    assert.deepEqual(await readInstallationBrands(client), [
      {
        publicBrand: "okou",
        slackWorkspaceId: "T_SLACK_BRAND_EXISTING",
      },
    ]);

    const defaults = await client.query<{ columnDefault: string | null }>(`
      SELECT "column_default" AS "columnDefault"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'slack_org_installations'
        AND "column_name" = 'public_brand'
    `);
    assert.deepEqual(defaults.rows, [{ columnDefault: "'okou'::text" }]);

    await client.query(`
      INSERT INTO "slack_org_installations" (
        "slack_workspace_id",
        "encrypted_bot_token",
        "bot_user_id"
      )
      VALUES (
        'T_SLACK_BRAND_NEW',
        'encrypted-new-token',
        'U_SLACK_BRAND_NEW'
      )
    `);
    const migratedRows = await readInstallationBrands(client);
    assert.deepEqual(migratedRows, [
      {
        publicBrand: "okou",
        slackWorkspaceId: "T_SLACK_BRAND_EXISTING",
      },
      { publicBrand: "okou", slackWorkspaceId: "T_SLACK_BRAND_NEW" },
    ]);

    const backfillSql = await fs.readFile(
      path.join(migrationsDirectory, `${backfillMigration}.sql`),
      "utf8",
    );
    await client.query(backfillSql);
    assert.deepEqual(await readInstallationBrands(client), migratedRows);

    console.log("   ✅ existing VM0 installation rows are backfilled to Okou");
    console.log("   ✅ new official installation rows default to Okou");
    console.log("   ✅ rerunning the backfill is a no-op\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateSlackOfficialBrandMigration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
