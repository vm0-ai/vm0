import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "0956_lean_spitfire";
const expansionMigration = "0957_built_in_model_keys_compatibility_relation";
const testDatabase = "migration_built_in_model_keys_relation";

const legacyRelation = "vm0_api_keys";
const canonicalRelation = "built_in_model_keys";
const relationIdentifiers = {
  [canonicalRelation]: '"built_in_model_keys"',
  [legacyRelation]: '"vm0_api_keys"',
} as const;

type RelationName = keyof typeof relationIdentifiers;

interface KeyRow {
  readonly api_key: string;
  readonly id: string;
  readonly label: string | null;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return databaseErrorCode(error) === code;
  });
}

async function validateMigrationSql(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  const normalizedSql = migrationSql.trim().replace(/\s+/gu, " ");
  assert.equal(
    normalizedSql,
    'CREATE VIEW "built_in_model_keys" AS SELECT "id", "vendor", "api_key", "label", "created_at", "updated_at" FROM "vm0_api_keys";',
  );
}

async function seedPreExpansionRow(client: Client): Promise<void> {
  await client.query(
    `
      INSERT INTO "vm0_api_keys" (
        "id",
        "vendor",
        "api_key",
        "label",
        "created_at",
        "updated_at"
      )
      VALUES ($1, $2, $3, $4, default, default)
    `,
    [
      "00000000-0000-4000-8000-000000095701",
      "historical-vendor",
      "historical-key",
      "historical-label",
    ],
  );
}

async function validatePreExpansionCatalog(client: Client): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(`
    SELECT
      "relname" AS "relationName",
      "relkind"::text AS "relationKind"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN (
        'built_in_model_keys',
        'vm0_api_keys'
      )
    ORDER BY "pg_class"."relname"
  `);
  assert.deepEqual(relations.rows, [
    { relationKind: "r", relationName: legacyRelation },
  ]);
}

async function validateExpandedCatalog(client: Client): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(`
    SELECT
      "relname" AS "relationName",
      "relkind"::text AS "relationKind"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN (
        'built_in_model_keys',
        'vm0_api_keys'
      )
    ORDER BY "pg_class"."relname"
  `);
  assert.deepEqual(relations.rows, [
    { relationKind: "v", relationName: canonicalRelation },
    { relationKind: "r", relationName: legacyRelation },
  ]);

  const columns = await client.query<{
    columnName: string;
    relationName: string;
  }>(`
    SELECT
      "table_name" AS "relationName",
      "column_name" AS "columnName"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" IN ('built_in_model_keys', 'vm0_api_keys')
    ORDER BY "table_name", "ordinal_position"
  `);
  const expectedColumns = [
    "id",
    "vendor",
    "api_key",
    "label",
    "created_at",
    "updated_at",
  ];
  assert.deepEqual(
    columns.rows,
    [canonicalRelation, legacyRelation].flatMap((relationName) => {
      return expectedColumns.map((columnName) => {
        return { columnName, relationName };
      });
    }),
  );

  const viewMetadata = await client.query<{
    isInsertableInto: string;
    isUpdatable: string;
  }>(`
    SELECT
      "is_insertable_into" AS "isInsertableInto",
      "is_updatable" AS "isUpdatable"
    FROM "information_schema"."views"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'built_in_model_keys'
  `);
  assert.deepEqual(viewMetadata.rows, [
    { isInsertableInto: "YES", isUpdatable: "YES" },
  ]);
}

async function selectKeyByVendor(
  client: Client,
  relation: RelationName,
  vendor: string,
): Promise<KeyRow[]> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<KeyRow>(
    `
      SELECT "id", "api_key", "label"
      FROM ${relationIdentifier}
      WHERE ${relationIdentifier}."vendor" = $1
      LIMIT 1
    `,
    [vendor],
  );
  return result.rows;
}

async function validateHistoricalRow(client: Client): Promise<void> {
  const legacyRows = await selectKeyByVendor(
    client,
    legacyRelation,
    "historical-vendor",
  );
  const canonicalRows = await selectKeyByVendor(
    client,
    canonicalRelation,
    "historical-vendor",
  );
  assert.deepEqual(legacyRows, [
    {
      api_key: "historical-key",
      id: "00000000-0000-4000-8000-000000095701",
      label: "historical-label",
    },
  ]);
  assert.deepEqual(canonicalRows, legacyRows);
}

async function validateCrossRelationLock(
  client: Client,
  databaseUrl: string,
  lockingRelation: RelationName,
  competingRelation: RelationName,
  id: string,
  label: string,
): Promise<void> {
  const lockingIdentifier = relationIdentifiers[lockingRelation];
  const competingIdentifier = relationIdentifiers[competingRelation];
  const contender = new Client({ connectionString: databaseUrl });
  await contender.connect();

  await client.query("BEGIN");
  try {
    const lockedRows = await client.query<{ id: string; label: string | null }>(
      `
        SELECT "id", "label"
        FROM ${lockingIdentifier}
        WHERE ${lockingIdentifier}."label" LIKE $1
        ORDER BY ${lockingIdentifier}."vendor"
        FOR UPDATE
      `,
      [`%${label}%`],
    );
    assert.deepEqual(lockedRows.rows, [{ id, label }]);

    await contender.query("BEGIN");
    await contender.query("SET LOCAL lock_timeout = '100ms'");
    await expectDatabaseFailure(
      contender.query(
        `
          UPDATE ${competingIdentifier}
          SET "label" = $1
          WHERE ${competingIdentifier}."id" = $2
        `,
        ["unexpected-lock-winner", id],
      ),
      "55P03",
    );
    await contender.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK");
    await contender.end();
  }
}

async function validateStatementShapes(
  client: Client,
  databaseUrl: string,
  relation: RelationName,
  counterpart: RelationName,
): Promise<void> {
  const relationIdentifier = relationIdentifiers[relation];
  const vendor = `${relation}-statement-shapes`;
  const apiKey = `${relation}-initial-key`;
  const initialLabel = `${relation}-initial-label`;

  const inserted = await client.query<KeyRow>(
    `
      INSERT INTO ${relationIdentifier} (
        "id",
        "vendor",
        "api_key",
        "label",
        "created_at",
        "updated_at"
      )
      VALUES (default, $1, $2, $3, default, default)
      RETURNING "id", "api_key", "label"
    `,
    [vendor, apiKey, initialLabel],
  );
  assert.equal(inserted.rows.length, 1);
  const [insertedRow] = inserted.rows;
  assert.ok(insertedRow);
  assert.equal(insertedRow.api_key, apiKey);
  assert.equal(insertedRow.label, initialLabel);
  assert.deepEqual(
    await selectKeyByVendor(client, counterpart, vendor),
    inserted.rows,
  );

  const doNothingVendor = `${relation}-do-nothing`;
  const doNothingSql = `
      INSERT INTO ${relationIdentifier} (
        "id",
        "vendor",
        "api_key",
        "label",
        "created_at",
        "updated_at"
      )
      VALUES (default, $1, $2, default, default, default)
      ON CONFLICT ("vendor") DO NOTHING
  `;
  const insertedWithoutConflict = await client.query(doNothingSql, [
    doNothingVendor,
    `${relation}-do-nothing-key`,
  ]);
  assert.equal(insertedWithoutConflict.rowCount, 1);
  const doNothingRows = await selectKeyByVendor(
    client,
    relation,
    doNothingVendor,
  );
  assert.equal(doNothingRows.length, 1);
  const [doNothingRow] = doNothingRows;
  assert.ok(doNothingRow);
  assert.match(doNothingRow.id, /^[0-9a-f-]{36}$/u);
  assert.equal(doNothingRow.api_key, `${relation}-do-nothing-key`);
  assert.equal(doNothingRow.label, null);
  assert.deepEqual(
    await selectKeyByVendor(client, counterpart, doNothingVendor),
    doNothingRows,
  );
  const ignoredConflict = await client.query(doNothingSql, [
    doNothingVendor,
    `${relation}-ignored-key`,
  ]);
  assert.equal(ignoredConflict.rowCount, 0);

  const upserted = await client.query<KeyRow>(
    `
      INSERT INTO ${relationIdentifier} (
        "id",
        "vendor",
        "api_key",
        "label",
        "created_at",
        "updated_at"
      )
      VALUES (default, $1, $2, $3, default, default)
      ON CONFLICT ("vendor") DO UPDATE SET "vendor" = $4
      RETURNING "id", "api_key", "label"
    `,
    [
      vendor,
      `${relation}-conflicting-key`,
      `${relation}-conflicting-label`,
      vendor,
    ],
  );
  assert.deepEqual(upserted.rows, inserted.rows);

  const updatedAt = new Date("2026-08-21T00:00:00.000Z");
  const updatedLabel = `${relation}-runtime-state-fixture`;
  const updated = await client.query<KeyRow>(
    `
      UPDATE ${relationIdentifier}
      SET "label" = $1, "updated_at" = $2
      WHERE ${relationIdentifier}."id" = $3
      RETURNING "id", "api_key", "label"
    `,
    [updatedLabel, updatedAt, insertedRow.id],
  );
  assert.equal(updated.rowCount, 1);
  const updatedRows = [{ ...insertedRow, label: updatedLabel }];
  assert.deepEqual(updated.rows, updatedRows);
  assert.deepEqual(
    await selectKeyByVendor(client, counterpart, vendor),
    updatedRows,
  );

  await validateCrossRelationLock(
    client,
    databaseUrl,
    relation,
    counterpart,
    insertedRow.id,
    updatedLabel,
  );

  const deleted = await client.query<KeyRow>(
    `
      DELETE FROM ${relationIdentifier}
      WHERE ${relationIdentifier}."id" = $1
      RETURNING "id", "api_key", "label"
    `,
    [insertedRow.id],
  );
  assert.equal(deleted.rowCount, 1);
  assert.deepEqual(deleted.rows, updatedRows);
  assert.deepEqual(await selectKeyByVendor(client, counterpart, vendor), []);
}

export async function validateBuiltInModelKeysCompatibilityRelation(): Promise<void> {
  console.log(
    "=== Validate built-in model key relation compatibility expansion ===\n",
  );

  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;

  await validateMigrationSql();

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
    await validatePreExpansionCatalog(client);
    await seedPreExpansionRow(client);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      expansionMigration,
    );

    await validateExpandedCatalog(client);
    await validateHistoricalRow(client);
    await validateStatementShapes(
      client,
      testUrl.toString(),
      legacyRelation,
      canonicalRelation,
    );
    await validateStatementShapes(
      client,
      testUrl.toString(),
      canonicalRelation,
      legacyRelation,
    );

    console.log("   ✅ the legacy table remains the physical relation");
    console.log("   ✅ the canonical view exposes the six explicit columns");
    console.log(
      "   ✅ both identities support SELECT, INSERT RETURNING, targeted conflict handling, UPDATE RETURNING, DELETE RETURNING, and cross-relation row locking\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateBuiltInModelKeysCompatibilityRelation().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
