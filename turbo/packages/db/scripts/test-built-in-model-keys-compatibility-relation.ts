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
const switchMigration = "0958_built_in_model_keys_physical_switch";
const contractPreviousMigration =
  "0964_reconcile_feishu_member_connector_links";
const contractMigration = "0965_contract_legacy_built_in_model_key_relation";
const testDatabase = "migration_built_in_model_keys_relation";

const legacyRelation = "vm0_api_keys";
const canonicalRelation = "built_in_model_keys";
const relationIdentifiers = {
  [canonicalRelation]: '"built_in_model_keys"',
  [legacyRelation]: '"vm0_api_keys"',
} as const;
const expectedColumns = [
  "id",
  "vendor",
  "api_key",
  "label",
  "created_at",
  "updated_at",
];

type RelationName = keyof typeof relationIdentifiers;

interface KeyRow {
  readonly api_key: string;
  readonly id: string;
  readonly label: string | null;
}

interface PreservedKeyRow extends KeyRow {
  readonly created_at: string;
  readonly updated_at: string;
  readonly vendor: string;
}

interface RelationDependency {
  readonly dependencyType: string;
  readonly dependentClass: string;
  readonly dependentIdentity: string;
  readonly isOwnRewrite: boolean | null;
  readonly isOwnRowType: boolean | null;
  readonly referencedColumnNumber: number;
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
  const expansionSql = await fs.readFile(
    path.join(migrationsDirectory, `${expansionMigration}.sql`),
    "utf8",
  );
  const normalizedExpansionSql = expansionSql.trim().replace(/\s+/gu, " ");
  assert.equal(
    normalizedExpansionSql,
    'CREATE VIEW "built_in_model_keys" AS SELECT "id", "vendor", "api_key", "label", "created_at", "updated_at" FROM "vm0_api_keys";',
  );

  const switchSql = await fs.readFile(
    path.join(migrationsDirectory, `${switchMigration}.sql`),
    "utf8",
  );
  const normalizedSwitchSql = switchSql
    .replaceAll("--> statement-breakpoint", "")
    .trim()
    .replace(/\s+/gu, " ");
  assert.equal(
    normalizedSwitchSql,
    'DROP VIEW "built_in_model_keys"; ALTER TABLE "vm0_api_keys" RENAME TO "built_in_model_keys"; ALTER TABLE "built_in_model_keys" RENAME CONSTRAINT "vm0_api_keys_pkey" TO "built_in_model_keys_pkey"; ALTER INDEX "idx_vm0_api_keys_vendor" RENAME TO "idx_built_in_model_keys_vendor"; CREATE VIEW "vm0_api_keys" AS SELECT "id", "vendor", "api_key", "label", "created_at", "updated_at" FROM "built_in_model_keys";',
  );
  assert.equal(/vm0:non-transactional|LOCK TABLE/u.test(switchSql), false);
  assert.equal(/INSERT INTO|UPDATE |DELETE FROM/u.test(switchSql), false);

  const contractSql = await fs.readFile(
    path.join(migrationsDirectory, `${contractMigration}.sql`),
    "utf8",
  );
  const normalizedContractSql = contractSql.trim().replace(/\s+/gu, " ");
  assert.equal(normalizedContractSql, 'DROP VIEW "vm0_api_keys";');
  assert.equal(/\bIF\s+EXISTS\b/iu.test(contractSql), false);
  assert.equal(/\bCASCADE\b/iu.test(contractSql), false);
  assert.equal(/vm0:non-transactional/iu.test(contractSql), false);
  assert.equal(/\bLOCK\s+TABLE\b/iu.test(contractSql), false);
  assert.equal(/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(contractSql), false);
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

async function validateSwitchedCatalog(client: Client): Promise<void> {
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
    { relationKind: "r", relationName: canonicalRelation },
    { relationKind: "v", relationName: legacyRelation },
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
    relationName: string;
  }>(`
    SELECT
      "table_name" AS "relationName",
      "is_insertable_into" AS "isInsertableInto",
      "is_updatable" AS "isUpdatable"
    FROM "information_schema"."views"
    WHERE "table_schema" = 'public'
      AND "table_name" IN ('built_in_model_keys', 'vm0_api_keys')
    ORDER BY "table_name"
  `);
  assert.deepEqual(viewMetadata.rows, [
    {
      isInsertableInto: "YES",
      isUpdatable: "YES",
      relationName: legacyRelation,
    },
  ]);

  const primaryKey = await client.query<{
    constraintName: string;
    relationName: string;
  }>(`
    SELECT
      "pg_constraint"."conname" AS "constraintName",
      "pg_class"."relname" AS "relationName"
    FROM "pg_constraint"
    INNER JOIN "pg_class"
      ON "pg_class"."oid" = "pg_constraint"."conrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" = 'built_in_model_keys'
      AND "pg_constraint"."contype" = 'p'
  `);
  assert.deepEqual(primaryKey.rows, [
    {
      constraintName: "built_in_model_keys_pkey",
      relationName: canonicalRelation,
    },
  ]);

  const physicalIndexes = await client.query<{
    isUnique: boolean;
    objectName: string;
  }>(`
    SELECT
      "index_relation"."relname" AS "objectName",
      "pg_index"."indisunique" AS "isUnique"
    FROM "pg_index"
    INNER JOIN "pg_class" AS "table_relation"
      ON "table_relation"."oid" = "pg_index"."indrelid"
    INNER JOIN "pg_class" AS "index_relation"
      ON "index_relation"."oid" = "pg_index"."indexrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "table_relation"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "table_relation"."relname" = 'built_in_model_keys'
      AND "index_relation"."relname" IN (
        'built_in_model_keys_pkey',
        'idx_built_in_model_keys_vendor',
        'idx_vm0_api_keys_vendor',
        'vm0_api_keys_pkey'
      )
    ORDER BY "index_relation"."relname"
  `);
  assert.deepEqual(physicalIndexes.rows, [
    { isUnique: true, objectName: "built_in_model_keys_pkey" },
    { isUnique: true, objectName: "idx_built_in_model_keys_vendor" },
  ]);
}

async function validateCanonicalSchemaAndIndexes(
  client: Client,
): Promise<void> {
  const columns = await client.query<{
    characterMaximumLength: number | null;
    columnName: string;
    dataType: string;
    isNullable: string;
    ordinalPosition: number;
  }>(`
    SELECT
      "ordinal_position" AS "ordinalPosition",
      "column_name" AS "columnName",
      "data_type" AS "dataType",
      "character_maximum_length" AS "characterMaximumLength",
      "is_nullable" AS "isNullable"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'built_in_model_keys'
    ORDER BY "ordinal_position"
  `);
  // Migration 0849 dropped the old model column in place, so the surviving
  // physical columns intentionally retain an ordinal-position gap.
  assert.deepEqual(columns.rows, [
    {
      characterMaximumLength: null,
      columnName: "id",
      dataType: "uuid",
      isNullable: "NO",
      ordinalPosition: 1,
    },
    {
      characterMaximumLength: 50,
      columnName: "vendor",
      dataType: "character varying",
      isNullable: "NO",
      ordinalPosition: 2,
    },
    {
      characterMaximumLength: null,
      columnName: "api_key",
      dataType: "text",
      isNullable: "NO",
      ordinalPosition: 4,
    },
    {
      characterMaximumLength: null,
      columnName: "label",
      dataType: "text",
      isNullable: "YES",
      ordinalPosition: 5,
    },
    {
      characterMaximumLength: null,
      columnName: "created_at",
      dataType: "timestamp without time zone",
      isNullable: "NO",
      ordinalPosition: 6,
    },
    {
      characterMaximumLength: null,
      columnName: "updated_at",
      dataType: "timestamp without time zone",
      isNullable: "NO",
      ordinalPosition: 7,
    },
  ]);

  const primaryKey = await client.query<{
    columnNames: string[];
    constraintName: string;
  }>(`
    SELECT
      "pg_constraint"."conname" AS "constraintName",
      array_agg(
        "pg_attribute"."attname"::text
        ORDER BY "constraint_key"."ordinality"
      ) AS "columnNames"
    FROM "pg_constraint"
    INNER JOIN "pg_class" AS "table_relation"
      ON "table_relation"."oid" = "pg_constraint"."conrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "table_relation"."relnamespace"
    CROSS JOIN LATERAL unnest("pg_constraint"."conkey")
      WITH ORDINALITY AS "constraint_key"("attribute_number", "ordinality")
    INNER JOIN "pg_attribute"
      ON "pg_attribute"."attrelid" = "table_relation"."oid"
      AND "pg_attribute"."attnum" = "constraint_key"."attribute_number"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "table_relation"."relname" = 'built_in_model_keys'
      AND "pg_constraint"."contype" = 'p'
    GROUP BY "pg_constraint"."conname"
  `);
  assert.deepEqual(primaryKey.rows, [
    {
      columnNames: ["id"],
      constraintName: "built_in_model_keys_pkey",
    },
  ]);

  const vendorIndex = await client.query<{
    columnNames: string[];
    indexName: string;
    isPrimary: boolean;
    isUnique: boolean;
  }>(`
    SELECT
      "index_relation"."relname" AS "indexName",
      "pg_index"."indisunique" AS "isUnique",
      "pg_index"."indisprimary" AS "isPrimary",
      array_agg(
        "pg_attribute"."attname"::text
        ORDER BY "index_key"."ordinality"
      ) AS "columnNames"
    FROM "pg_index"
    INNER JOIN "pg_class" AS "table_relation"
      ON "table_relation"."oid" = "pg_index"."indrelid"
    INNER JOIN "pg_class" AS "index_relation"
      ON "index_relation"."oid" = "pg_index"."indexrelid"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "table_relation"."relnamespace"
    CROSS JOIN LATERAL unnest("pg_index"."indkey")
      WITH ORDINALITY AS "index_key"("attribute_number", "ordinality")
    INNER JOIN "pg_attribute"
      ON "pg_attribute"."attrelid" = "table_relation"."oid"
      AND "pg_attribute"."attnum" = "index_key"."attribute_number"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "table_relation"."relname" = 'built_in_model_keys'
      AND "index_relation"."relname" = 'idx_built_in_model_keys_vendor'
    GROUP BY
      "index_relation"."relname",
      "pg_index"."indisunique",
      "pg_index"."indisprimary"
  `);
  assert.deepEqual(vendorIndex.rows, [
    {
      columnNames: ["vendor"],
      indexName: "idx_built_in_model_keys_vendor",
      isPrimary: false,
      isUnique: true,
    },
  ]);
}

async function readCanonicalRows(client: Client): Promise<PreservedKeyRow[]> {
  const rows = await client.query<PreservedKeyRow>(`
    SELECT
      "id",
      "vendor",
      "api_key",
      "label",
      "created_at"::text AS "created_at",
      "updated_at"::text AS "updated_at"
    FROM "built_in_model_keys"
    ORDER BY "id"
  `);
  return rows.rows;
}

async function readLegacyRelationDependencies(
  client: Client,
): Promise<RelationDependency[]> {
  const dependencies = await client.query<RelationDependency>(`
    WITH "legacy_relation" AS (
      SELECT "pg_class"."oid"
      FROM "pg_class"
      INNER JOIN "pg_namespace"
        ON "pg_namespace"."oid" = "pg_class"."relnamespace"
      WHERE "pg_namespace"."nspname" = 'public'
        AND "pg_class"."relname" = 'vm0_api_keys'
    )
    SELECT
      "pg_depend"."classid"::regclass::text AS "dependentClass",
      "pg_depend"."deptype"::text AS "dependencyType",
      "pg_depend"."refobjsubid" AS "referencedColumnNumber",
      pg_describe_object(
        "pg_depend"."classid",
        "pg_depend"."objid",
        "pg_depend"."objsubid"
      ) AS "dependentIdentity",
      "pg_rewrite"."ev_class" = "legacy_relation"."oid" AS "isOwnRewrite",
      "pg_type"."typrelid" = "legacy_relation"."oid" AS "isOwnRowType"
    FROM "legacy_relation"
    INNER JOIN "pg_depend"
      ON "pg_depend"."refclassid" = 'pg_class'::regclass
      AND "pg_depend"."refobjid" = "legacy_relation"."oid"
    LEFT JOIN "pg_rewrite"
      ON "pg_depend"."classid" = 'pg_rewrite'::regclass
      AND "pg_rewrite"."oid" = "pg_depend"."objid"
    LEFT JOIN "pg_type"
      ON "pg_depend"."classid" = 'pg_type'::regclass
      AND "pg_type"."oid" = "pg_depend"."objid"
    ORDER BY
      "dependentClass",
      "dependentIdentity",
      "referencedColumnNumber"
  `);
  return dependencies.rows;
}

function isInternalLegacyViewDependency(
  dependency: RelationDependency,
): boolean {
  return dependency.isOwnRewrite === true || dependency.isOwnRowType === true;
}

function validateLegacyViewInternalDependencies(
  dependencies: RelationDependency[],
): RelationDependency[] {
  const internalDependencies = dependencies.filter((dependency) => {
    return isInternalLegacyViewDependency(dependency);
  });
  assert.deepEqual(internalDependencies, [
    {
      dependencyType: "i",
      dependentClass: "pg_rewrite",
      dependentIdentity: "rule _RETURN on view vm0_api_keys",
      isOwnRewrite: true,
      isOwnRowType: null,
      referencedColumnNumber: 0,
    },
    {
      dependencyType: "i",
      dependentClass: "pg_type",
      dependentIdentity: "type vm0_api_keys",
      isOwnRewrite: null,
      isOwnRowType: true,
      referencedColumnNumber: 0,
    },
  ]);
  return dependencies.filter((dependency) => {
    return !isInternalLegacyViewDependency(dependency);
  });
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

async function countRows(
  client: Client,
  relation: RelationName,
): Promise<number> {
  const relationIdentifier = relationIdentifiers[relation];
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM ${relationIdentifier}`,
  );
  const count = result.rows[0]?.count;
  assert.ok(count !== undefined);
  return count;
}

async function validateDependencyRollbackWriteBehavior(
  client: Client,
): Promise<void> {
  const vendor = "contract-dependency-rollback";
  const inserted = await client.query<KeyRow>(
    `
      INSERT INTO "built_in_model_keys" (
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
    [vendor, "rollback-key", "rollback-label"],
  );
  assert.equal(inserted.rows.length, 1);
  assert.deepEqual(
    await selectKeyByVendor(client, legacyRelation, vendor),
    inserted.rows,
  );

  const [insertedRow] = inserted.rows;
  assert.ok(insertedRow);
  const updated = await client.query<KeyRow>(
    `
      UPDATE "vm0_api_keys"
      SET "label" = $1
      WHERE "id" = $2
      RETURNING "id", "api_key", "label"
    `,
    ["rollback-updated-label", insertedRow.id],
  );
  const updatedRows = [{ ...insertedRow, label: "rollback-updated-label" }];
  assert.deepEqual(updated.rows, updatedRows);

  const deleted = await client.query<KeyRow>(
    `
      DELETE FROM "built_in_model_keys"
      WHERE "id" = $1
      RETURNING "id", "api_key", "label"
    `,
    [insertedRow.id],
  );
  assert.deepEqual(deleted.rows, updatedRows);
  assert.deepEqual(
    await selectKeyByVendor(client, canonicalRelation, vendor),
    [],
  );
  assert.deepEqual(await selectKeyByVendor(client, legacyRelation, vendor), []);
}

async function validateContractedCatalog(client: Client): Promise<void> {
  const relations = await client.query<{
    relationKind: string;
    relationName: string;
  }>(`
    SELECT
      "pg_class"."relname" AS "relationName",
      "pg_class"."relkind"::text AS "relationKind"
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
    { relationKind: "r", relationName: canonicalRelation },
  ]);

  const legacyRegclass = await client.query<{
    relationName: string | null;
  }>(`
    SELECT to_regclass('public.vm0_api_keys')::text AS "relationName"
  `);
  assert.deepEqual(legacyRegclass.rows, [{ relationName: null }]);

  const legacyObjects = await client.query<{
    objectName: string;
    objectType: string;
  }>(`
    SELECT 'relation' AS "objectType", "pg_class"."relname" AS "objectName"
    FROM "pg_class"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_class"."relnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_class"."relname" IN (
        'vm0_api_keys',
        'vm0_api_keys_pkey',
        'idx_vm0_api_keys_vendor'
      )
    UNION ALL
    SELECT
      'constraint' AS "objectType",
      "pg_constraint"."conname" AS "objectName"
    FROM "pg_constraint"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_constraint"."connamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_constraint"."conname" = 'vm0_api_keys_pkey'
    UNION ALL
    SELECT 'type' AS "objectType", "pg_type"."typname" AS "objectName"
    FROM "pg_type"
    INNER JOIN "pg_namespace"
      ON "pg_namespace"."oid" = "pg_type"."typnamespace"
    WHERE "pg_namespace"."nspname" = 'public'
      AND "pg_type"."typname" = 'vm0_api_keys'
    ORDER BY "objectType", "objectName"
  `);
  assert.deepEqual(legacyObjects.rows, []);
  assert.deepEqual(await readLegacyRelationDependencies(client), []);
  await validateCanonicalSchemaAndIndexes(client);
}

async function validateLegacyStatementsFail(client: Client): Promise<void> {
  const legacyStatements: ReadonlyArray<() => Promise<unknown>> = [
    () => {
      return client.query(`SELECT "id" FROM "vm0_api_keys" LIMIT 1`);
    },
    () => {
      return client.query(`
        INSERT INTO "vm0_api_keys" ("vendor", "api_key")
        VALUES ('contract-legacy-insert', 'contract-legacy-key')
      `);
    },
    () => {
      return client.query(`
        UPDATE "vm0_api_keys"
        SET "label" = 'contract-legacy-update'
        WHERE "vendor" = 'contract-legacy-insert'
      `);
    },
    () => {
      return client.query(`
        DELETE FROM "vm0_api_keys"
        WHERE "vendor" = 'contract-legacy-insert'
      `);
    },
  ];
  for (const statement of legacyStatements) {
    await expectDatabaseFailure(statement(), "42P01");
  }
}

async function validateTwoSessionRelationLock(
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
  counterpart: RelationName | undefined,
  stage: "contract" | "expand" | "switch",
): Promise<void> {
  const relationIdentifier = relationIdentifiers[relation];
  const vendor = `${stage}-${relation}-statement-shapes`;
  const apiKey = `${stage}-${relation}-initial-key`;
  const initialLabel = `${stage}-${relation}-initial-label`;

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
    await selectKeyByVendor(client, relation, vendor),
    inserted.rows,
  );
  if (counterpart !== undefined) {
    assert.deepEqual(
      await selectKeyByVendor(client, counterpart, vendor),
      inserted.rows,
    );
  }

  const doNothingVendor = `${stage}-${relation}-do-nothing`;
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
    `${stage}-${relation}-do-nothing-key`,
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
  assert.equal(doNothingRow.api_key, `${stage}-${relation}-do-nothing-key`);
  assert.equal(doNothingRow.label, null);
  if (counterpart !== undefined) {
    assert.deepEqual(
      await selectKeyByVendor(client, counterpart, doNothingVendor),
      doNothingRows,
    );
  }
  const ignoredConflict = await client.query(doNothingSql, [
    doNothingVendor,
    `${stage}-${relation}-ignored-key`,
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
      `${stage}-${relation}-conflicting-key`,
      `${stage}-${relation}-conflicting-label`,
      vendor,
    ],
  );
  assert.deepEqual(upserted.rows, inserted.rows);

  const updatedAt = new Date("2026-08-21T00:00:00.000Z");
  const updatedLabel = `${stage}-${relation}-runtime-state-fixture`;
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
  if (counterpart !== undefined) {
    assert.deepEqual(
      await selectKeyByVendor(client, counterpart, vendor),
      updatedRows,
    );
  }

  await validateTwoSessionRelationLock(
    client,
    databaseUrl,
    relation,
    counterpart ?? relation,
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
  assert.deepEqual(await selectKeyByVendor(client, relation, vendor), []);
  if (counterpart !== undefined) {
    assert.deepEqual(await selectKeyByVendor(client, counterpart, vendor), []);
  }

  if (stage === "contract") {
    const cleanup = await client.query<KeyRow>(
      `
        DELETE FROM ${relationIdentifier}
        WHERE ${relationIdentifier}."vendor" = $1
        RETURNING "id", "api_key", "label"
      `,
      [doNothingVendor],
    );
    assert.deepEqual(cleanup.rows, doNothingRows);
  }
}

export async function validateBuiltInModelKeysCompatibilityRelation(): Promise<void> {
  console.log(
    "=== Validate built-in model key relation compatibility transition ===\n",
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
      "expand",
    );
    await validateStatementShapes(
      client,
      testUrl.toString(),
      canonicalRelation,
      legacyRelation,
      "expand",
    );

    const rowCountBeforeSwitch = await countRows(client, legacyRelation);
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      switchMigration,
    );

    await validateSwitchedCatalog(client);
    await validateHistoricalRow(client);
    assert.equal(
      await countRows(client, canonicalRelation),
      rowCountBeforeSwitch,
    );
    await validateStatementShapes(
      client,
      testUrl.toString(),
      legacyRelation,
      canonicalRelation,
      "switch",
    );
    await validateStatementShapes(
      client,
      testUrl.toString(),
      canonicalRelation,
      legacyRelation,
      "switch",
    );
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractPreviousMigration,
    );

    const rowsBeforeContract = await readCanonicalRows(client);
    const rowCountBeforeContract = await countRows(client, canonicalRelation);
    assert.equal(rowsBeforeContract.length, rowCountBeforeContract);
    await validateCanonicalSchemaAndIndexes(client);

    const dependenciesBeforeProbe =
      await readLegacyRelationDependencies(client);
    assert.deepEqual(
      validateLegacyViewInternalDependencies(dependenciesBeforeProbe),
      [],
    );
    await client.query(`
      CREATE VIEW "vm0_api_keys_contract_dependency" AS
      SELECT "id", "vendor"
      FROM "vm0_api_keys"
    `);
    const dependenciesWithProbe = await readLegacyRelationDependencies(client);
    assert.deepEqual(
      validateLegacyViewInternalDependencies(dependenciesWithProbe),
      [
        {
          dependencyType: "n",
          dependentClass: "pg_rewrite",
          dependentIdentity:
            "rule _RETURN on view vm0_api_keys_contract_dependency",
          isOwnRewrite: false,
          isOwnRowType: null,
          referencedColumnNumber: 1,
        },
        {
          dependencyType: "n",
          dependentClass: "pg_rewrite",
          dependentIdentity:
            "rule _RETURN on view vm0_api_keys_contract_dependency",
          isOwnRewrite: false,
          isOwnRowType: null,
          referencedColumnNumber: 2,
        },
      ],
    );

    await client.query("BEGIN");
    try {
      await expectDatabaseFailure(
        applyMigrationsFromDirectoryUpToTag(
          client,
          migrationsDirectory,
          contractMigration,
        ),
        "2BP01",
      );
    } finally {
      await client.query("ROLLBACK");
    }

    const failedContractLedger = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = $1
      `,
      [contractMigration],
    );
    assert.deepEqual(failedContractLedger.rows, [{ count: 0 }]);
    await validateSwitchedCatalog(client);
    await validateCanonicalSchemaAndIndexes(client);
    assert.equal(
      await countRows(client, canonicalRelation),
      rowCountBeforeContract,
    );
    assert.deepEqual(await readCanonicalRows(client), rowsBeforeContract);
    assert.deepEqual(
      await readLegacyRelationDependencies(client),
      dependenciesWithProbe,
    );
    await validateDependencyRollbackWriteBehavior(client);
    assert.deepEqual(await readCanonicalRows(client), rowsBeforeContract);

    await client.query(`DROP VIEW "vm0_api_keys_contract_dependency"`);
    assert.deepEqual(
      validateLegacyViewInternalDependencies(
        await readLegacyRelationDependencies(client),
      ),
      [],
    );

    await client.query("BEGIN");
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      contractMigration,
    );
    await client.query("COMMIT");

    const successfulContractLedger = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = $1
      `,
      [contractMigration],
    );
    assert.deepEqual(successfulContractLedger.rows, [{ count: 1 }]);
    await validateContractedCatalog(client);
    assert.equal(
      await countRows(client, canonicalRelation),
      rowCountBeforeContract,
    );
    assert.deepEqual(await readCanonicalRows(client), rowsBeforeContract);
    await validateLegacyStatementsFail(client);
    await validateStatementShapes(
      client,
      testUrl.toString(),
      canonicalRelation,
      undefined,
      "contract",
    );
    assert.deepEqual(await readCanonicalRows(client), rowsBeforeContract);

    console.log("   ✅ expand-stage compatibility remains covered");
    console.log("   ✅ the canonical table retains every pre-switch row");
    console.log(
      "   ✅ the legacy view exposes the six explicit, auto-updatable columns",
    );
    console.log(
      "   ✅ the physical constraint and indexes use canonical names",
    );
    console.log(
      "   ✅ a persisted dependency fails the contract with 2BP01 and rolls back every catalog, row, index, and write invariant",
    );
    console.log(
      "   ✅ the successful contract removes the legacy identity with 42P01 while preserving canonical schema and rows",
    );
    console.log(
      "   ✅ every applicable stage supports explicit SELECT, INSERT RETURNING, targeted conflict handling, UPDATE RETURNING, DELETE RETURNING, and two-session row locking\n",
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
