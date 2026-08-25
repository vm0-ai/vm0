import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0994_last_butterfly";
const finalizationMigration =
  "0995_canonicalize_official_slack_installation_brand";
const testDatabase = "migration_slack_official_brand_finalization";

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
  console.log("=== Validate official Slack brand finalization ===\n");

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
      VALUES
        (
          'T_SLACK_BRAND_RESIDUE',
          'encrypted-residue-token',
          'U_SLACK_BRAND_RESIDUE',
          'vm0'
        ),
        (
          'T_SLACK_BRAND_CANONICAL',
          'encrypted-canonical-token',
          'U_SLACK_BRAND_CANONICAL',
          'okou'
        )
    `);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      finalizationMigration,
    );

    const migratedRows = await readInstallationBrands(client);
    assert.deepEqual(migratedRows, [
      {
        publicBrand: "okou",
        slackWorkspaceId: "T_SLACK_BRAND_CANONICAL",
      },
      {
        publicBrand: "okou",
        slackWorkspaceId: "T_SLACK_BRAND_RESIDUE",
      },
    ]);

    const finalizationSql = await fs.readFile(
      path.join(migrationsDirectory, `${finalizationMigration}.sql`),
      "utf8",
    );
    await client.query(finalizationSql);
    assert.deepEqual(await readInstallationBrands(client), migratedRows);

    console.log("   ✅ stale VM0 installation rows are finalized as Okou");
    console.log("   ✅ canonical Okou installation rows stay unchanged");
    console.log("   ✅ rerunning the finalization is a no-op\n");
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
