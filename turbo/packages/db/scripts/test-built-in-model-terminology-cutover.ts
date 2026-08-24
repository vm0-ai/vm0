import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0988_lyrical_baron_strucker";
const cutoverMigration = "0991_cutover_built_in_model_terminology";
const testDatabase = "migration_built_in_model_terminology_cutover";
const orgId = "org_built_in_model_terminology_cutover";
const orgSentinelUserId = "__org__";
const fixtureTimestamp = new Date(2026, 0, 1).getTime();

interface CooldownRow {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly unavailableUntil: Date;
  readonly upstreamModel: string;
}

interface SwitchesRow {
  readonly switches: Record<string, boolean>;
  readonly updatedAt: Date;
  readonly userId: string;
}

async function seedCooldownFixtures(client: Client): Promise<void> {
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
}

async function seedFeatureSwitchFixtures(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "user_feature_switches" (
        "org_id",
        "user_id",
        "switches",
        "updated_at"
      )
      VALUES
        ($1, 'user_enabled', '{"managedModelProviderFallback": true, "lab": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_disabled', '{"managedModelProviderFallback": false}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_canonical', '{"managedModelProviderFallback": true, "builtInModelProviderFallback": false}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_canonical_only', '{"builtInModelProviderFallback": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, 'user_untouched', '{"lab": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00'),
        ($1, $2, '{"managedModelProviderFallback": true, "piLoop": true}'::jsonb, TIMESTAMP '2026-01-01 00:00:00')
    `,
    [orgId, orgSentinelUserId],
  );
}

async function readCooldownRows(
  client: Client,
  tableName:
    | "built_in_model_candidate_cooldown"
    | "managed_model_candidate_cooldown",
): Promise<readonly CooldownRow[]> {
  const result = await client.query<CooldownRow>(`
    SELECT
      "selected_model" AS "selectedModel",
      "provider_type" AS "providerType",
      "upstream_model" AS "upstreamModel",
      "unavailable_until" AS "unavailableUntil"
    FROM "${tableName}"
    ORDER BY "selected_model", "provider_type", "upstream_model"
  `);
  return result.rows;
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

function serializedCooldownRows(
  rows: readonly CooldownRow[],
): readonly object[] {
  return rows.map((row) => {
    return {
      ...row,
      unavailableUntil: row.unavailableUntil.toISOString(),
    };
  });
}

function serializedFeatureSwitchRows(
  rows: readonly SwitchesRow[],
): readonly object[] {
  return rows.map((row) => {
    return {
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
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

function assertCooldownState(rows: readonly CooldownRow[]): void {
  assert.deepEqual(serializedCooldownRows(rows), [
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
}

function assertFeatureSwitchState(rows: readonly SwitchesRow[]): void {
  assert.deepEqual(rowByUserId(rows, "user_enabled").switches, {
    builtInModelProviderFallback: true,
    lab: true,
    managedModelProviderFallback: true,
  });
  assert.deepEqual(rowByUserId(rows, "user_disabled").switches, {
    builtInModelProviderFallback: false,
    managedModelProviderFallback: false,
  });
  assert.deepEqual(rowByUserId(rows, orgSentinelUserId).switches, {
    builtInModelProviderFallback: true,
    managedModelProviderFallback: true,
    piLoop: true,
  });
  assert.deepEqual(rowByUserId(rows, "user_canonical").switches, {
    builtInModelProviderFallback: false,
    managedModelProviderFallback: true,
  });

  for (const userId of [
    "user_canonical",
    "user_canonical_only",
    "user_untouched",
  ]) {
    assert.equal(
      rowByUserId(rows, userId).updatedAt.getTime(),
      fixtureTimestamp,
    );
  }
  assert.deepEqual(rowByUserId(rows, "user_canonical_only").switches, {
    builtInModelProviderFallback: true,
  });
  assert.deepEqual(rowByUserId(rows, "user_untouched").switches, {
    lab: true,
  });
}

export async function validateBuiltInModelTerminologyCutover(): Promise<void> {
  console.log("=== Validate built-in model terminology cutover ===\n");

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
    await seedCooldownFixtures(client);
    await seedFeatureSwitchFixtures(client);
    const legacyRowsBeforeCutover = await readCooldownRows(
      client,
      "managed_model_candidate_cooldown",
    );

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      cutoverMigration,
    );

    assertCooldownState(
      await readCooldownRows(client, "built_in_model_candidate_cooldown"),
    );
    assert.deepEqual(
      serializedCooldownRows(
        await readCooldownRows(client, "managed_model_candidate_cooldown"),
      ),
      serializedCooldownRows(legacyRowsBeforeCutover),
    );
    const migratedSwitchRows = await readFeatureSwitchRows(client);
    assertFeatureSwitchState(migratedSwitchRows);

    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${cutoverMigration}.sql`),
      "utf8",
    );
    const cooldownsBeforeRerun = serializedCooldownRows(
      await readCooldownRows(client, "built_in_model_candidate_cooldown"),
    );
    const switchesBeforeRerun = serializedFeatureSwitchRows(migratedSwitchRows);
    await client.query(migrationSql);

    assert.deepEqual(
      serializedCooldownRows(
        await readCooldownRows(client, "built_in_model_candidate_cooldown"),
      ),
      cooldownsBeforeRerun,
    );
    assert.deepEqual(
      serializedFeatureSwitchRows(await readFeatureSwitchRows(client)),
      switchesBeforeRerun,
    );

    console.log("   ✅ post-snapshot legacy cooldowns are reconciled");
    console.log("   ✅ later built-in cooldown deadlines remain authoritative");
    console.log("   ✅ canonical switch values preserve booleans and siblings");
    console.log("   ✅ legacy switch values remain available for old APIs");
    console.log(
      "   ✅ existing canonical values and untouched rows are stable",
    );
    console.log("   ✅ rerunning the cutover is a no-op\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateBuiltInModelTerminologyCutover().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
