import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0978_remove_retired_agent_compose_plane";
const schemaMigration = "0979_expand_built_in_model_candidate_cooldown";
const backfillMigration = "0980_backfill_built_in_model_candidate_cooldown";
const testDatabase = "migration_built_in_model_candidate_cooldown_expansion";

interface CooldownRow {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly unavailableUntil: Date;
  readonly upstreamModel: string;
}

interface ColumnRow {
  readonly characterMaximumLength: number | null;
  readonly columnName: string;
  readonly dataType: string;
  readonly isNullable: "NO" | "YES";
}

async function readCooldownRows(
  client: Client,
  tableName:
    | "built_in_model_candidate_cooldown"
    | "managed_model_candidate_cooldown",
): Promise<readonly CooldownRow[]> {
  const result = await client.query<CooldownRow>(
    `
      SELECT
        "selected_model" AS "selectedModel",
        "provider_type" AS "providerType",
        "upstream_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil"
      FROM "${tableName}"
      ORDER BY "selected_model", "provider_type", "upstream_model"
    `,
  );
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

async function assertBuiltInTableShape(client: Client): Promise<void> {
  const columns = await client.query<ColumnRow>(`
    SELECT
      "column_name" AS "columnName",
      "data_type" AS "dataType",
      "is_nullable" AS "isNullable",
      "character_maximum_length" AS "characterMaximumLength"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'built_in_model_candidate_cooldown'
    ORDER BY "ordinal_position"
  `);
  assert.deepEqual(columns.rows, [
    {
      columnName: "selected_model",
      dataType: "character varying",
      isNullable: "NO",
      characterMaximumLength: 255,
    },
    {
      columnName: "provider_type",
      dataType: "character varying",
      isNullable: "NO",
      characterMaximumLength: 100,
    },
    {
      columnName: "upstream_model",
      dataType: "character varying",
      isNullable: "NO",
      characterMaximumLength: 255,
    },
    {
      columnName: "unavailable_until",
      dataType: "timestamp without time zone",
      isNullable: "NO",
      characterMaximumLength: null,
    },
  ]);

  const primaryKey = await client.query<{ columnName: string }>(`
    SELECT "attribute"."attname" AS "columnName"
    FROM "pg_constraint" AS "constraint"
    JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "constraint"."conrelid"
    JOIN LATERAL unnest("constraint"."conkey") WITH ORDINALITY
      AS "key_column"("attribute_number", "position") ON TRUE
    JOIN "pg_attribute" AS "attribute"
      ON "attribute"."attrelid" = "relation"."oid"
      AND "attribute"."attnum" = "key_column"."attribute_number"
    WHERE "relation"."relname" = 'built_in_model_candidate_cooldown'
      AND "constraint"."contype" = 'p'
    ORDER BY "key_column"."position"
  `);
  assert.deepEqual(
    primaryKey.rows.map((row) => {
      return row.columnName;
    }),
    ["selected_model", "provider_type", "upstream_model"],
  );
}

export async function validateBuiltInModelCandidateCooldownExpansion(): Promise<void> {
  console.log("=== Validate built-in model cooldown expansion ===\n");

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
        ('model-a', 'provider-a', 'upstream-a', TIMESTAMP '2026-08-24 01:00:00'),
        ('model-b', 'provider-b', 'upstream-b', TIMESTAMP '2026-08-24 02:00:00')
    `);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      schemaMigration,
    );
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      backfillMigration,
    );

    await assertBuiltInTableShape(client);
    const legacyRows = await readCooldownRows(
      client,
      "managed_model_candidate_cooldown",
    );
    const copiedRows = await readCooldownRows(
      client,
      "built_in_model_candidate_cooldown",
    );
    assert.deepEqual(serializedRows(copiedRows), serializedRows(legacyRows));

    const backfillSql = await fs.readFile(
      path.join(migrationsDirectory, `${backfillMigration}.sql`),
      "utf8",
    );
    await client.query(`
      UPDATE "managed_model_candidate_cooldown"
      SET "unavailable_until" = TIMESTAMP '2026-08-24 03:00:00'
      WHERE "selected_model" = 'model-a'
    `);
    await client.query(backfillSql);
    let rerunRows = await readCooldownRows(
      client,
      "built_in_model_candidate_cooldown",
    );
    assert.equal(
      rerunRows[0]?.unavailableUntil.getTime(),
      new Date(2026, 7, 24, 3).getTime(),
    );

    await client.query(`
      UPDATE "built_in_model_candidate_cooldown"
      SET "unavailable_until" = TIMESTAMP '2026-08-24 05:00:00'
      WHERE "selected_model" = 'model-b'
    `);
    await client.query(`
      UPDATE "managed_model_candidate_cooldown"
      SET "unavailable_until" = TIMESTAMP '2026-08-24 04:00:00'
      WHERE "selected_model" = 'model-b'
    `);
    await client.query(backfillSql);
    rerunRows = await readCooldownRows(
      client,
      "built_in_model_candidate_cooldown",
    );
    assert.equal(
      rerunRows[1]?.unavailableUntil.getTime(),
      new Date(2026, 7, 24, 5).getTime(),
    );

    const beforeIdempotentRerun = serializedRows(rerunRows);
    await client.query(backfillSql);
    assert.deepEqual(
      serializedRows(
        await readCooldownRows(client, "built_in_model_candidate_cooldown"),
      ),
      beforeIdempotentRerun,
    );

    console.log("   ✅ the built-in table matches the legacy table shape");
    console.log(
      "   ✅ legacy rows are copied without removing the source rows",
    );
    console.log("   ✅ reruns advance only genuinely later deadlines");
    console.log("   ✅ rerunning without newer data is a no-op\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateBuiltInModelCandidateCooldownExpansion().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
