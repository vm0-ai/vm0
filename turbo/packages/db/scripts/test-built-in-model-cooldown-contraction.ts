import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { validatePermanentBuiltInModelCooldownState } from "./test-built-in-model-cooldown-permanent";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0988_lyrical_baron_strucker";
const cutoverMigration = "0991_cutover_built_in_model_terminology";
const contractionMigration =
  "0993_contract_legacy_built_in_model_cooldown_storage";
const testDatabase = "migration_built_in_model_cooldown_contraction";

interface CooldownRow {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly unavailableUntil: Date;
  readonly upstreamModel: string;
}

async function readCanonicalRows(
  client: Client,
): Promise<readonly CooldownRow[]> {
  const result = await client.query<CooldownRow>(`
    SELECT
      "selected_model" AS "selectedModel",
      "provider_type" AS "providerType",
      "upstream_model" AS "upstreamModel",
      "unavailable_until" AS "unavailableUntil"
    FROM "built_in_model_candidate_cooldown"
    ORDER BY "selected_model", "provider_type", "upstream_model"
  `);
  return result.rows;
}

function serializedRows(rows: readonly CooldownRow[]): readonly object[] {
  return rows.map((row) => {
    return {
      ...row,
      unavailableUntil: row.unavailableUntil.toISOString(),
    };
  });
}

export async function validateBuiltInModelCooldownContraction(): Promise<void> {
  console.log("=== Validate built-in model cooldown contraction ===\n");

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
      INSERT INTO "managed_model_candidate_cooldown" (
        "selected_model",
        "provider_type",
        "upstream_model",
        "unavailable_until"
      )
      VALUES
        ('legacy-only', 'provider-a', 'upstream-a', TIMESTAMP '2026-08-24 03:00:00'),
        ('later-built-in', 'provider-b', 'upstream-b', TIMESTAMP '2026-08-24 04:00:00')
    `);
    await client.query(`
      INSERT INTO "built_in_model_candidate_cooldown" (
        "selected_model",
        "provider_type",
        "upstream_model",
        "unavailable_until"
      )
      VALUES
        ('later-built-in', 'provider-b', 'upstream-b', TIMESTAMP '2026-08-24 05:00:00'),
        ('built-in-only', 'provider-c', 'upstream-c', TIMESTAMP '2026-08-24 06:00:00')
    `);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      cutoverMigration,
    );
    const rowsBeforeContraction = serializedRows(
      await readCanonicalRows(client),
    );
    assert.deepEqual(rowsBeforeContraction, [
      {
        providerType: "provider-c",
        selectedModel: "built-in-only",
        unavailableUntil: new Date(2026, 7, 24, 6).toISOString(),
        upstreamModel: "upstream-c",
      },
      {
        providerType: "provider-b",
        selectedModel: "later-built-in",
        unavailableUntil: new Date(2026, 7, 24, 5).toISOString(),
        upstreamModel: "upstream-b",
      },
      {
        providerType: "provider-a",
        selectedModel: "legacy-only",
        unavailableUntil: new Date(2026, 7, 24, 3).toISOString(),
        upstreamModel: "upstream-a",
      },
    ]);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractionMigration,
    );

    const relations = await client.query<{
      canonicalRelation: string | null;
      legacyRelation: string | null;
    }>(`
      SELECT
        to_regclass('public.built_in_model_candidate_cooldown')::text
          AS "canonicalRelation",
        to_regclass('public.managed_model_candidate_cooldown')::text
          AS "legacyRelation"
    `);
    assert.deepEqual(relations.rows, [
      {
        canonicalRelation: "built_in_model_candidate_cooldown",
        legacyRelation: null,
      },
    ]);
    assert.deepEqual(
      serializedRows(await readCanonicalRows(client)),
      rowsBeforeContraction,
    );

    await validatePermanentBuiltInModelCooldownState(testUrl.toString());
    assert.deepEqual(
      serializedRows(await readCanonicalRows(client)),
      rowsBeforeContraction,
    );

    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${contractionMigration}.sql`),
      "utf8",
    );
    assert.equal(
      migrationSql.trim(),
      'DROP TABLE "managed_model_candidate_cooldown";',
    );

    console.log("   ✅ the legacy cooldown table is absent");
    console.log("   ✅ canonical rows and later deadlines are unchanged");
    console.log(
      "   ✅ canonical primary key and current statements remain legal",
    );
    console.log("   ✅ the contraction uses a fail-closed table drop\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateBuiltInModelCooldownContraction().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
