import assert from "node:assert/strict";
import { Client } from "pg";

function databaseErrorField(
  error: unknown,
  field: "code" | "constraint",
): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = Reflect.get(error, field);
  return typeof value === "string" ? value : undefined;
}

async function validateCanonicalCatalog(client: Client): Promise<void> {
  const columns = await client.query<{
    columnDefault: string | null;
    columnName: string;
    formattedType: string;
    hasMissing: boolean;
    isNullable: "NO" | "YES";
  }>(`
    SELECT
      "column_row"."column_name" AS "columnName",
      "column_row"."column_default" AS "columnDefault",
      pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) AS "formattedType",
      "attribute_row"."atthasmissing" AS "hasMissing",
      "column_row"."is_nullable" AS "isNullable"
    FROM "information_schema"."columns" AS "column_row"
    INNER JOIN "pg_catalog"."pg_attribute" AS "attribute_row"
      ON "attribute_row"."attrelid" = 'public.org_metadata'::regclass
      AND "attribute_row"."attname" = "column_row"."column_name"
      AND NOT "attribute_row"."attisdropped"
    WHERE "column_row"."table_schema" = 'public'
      AND "column_row"."table_name" = 'org_metadata'
      AND "column_row"."column_name" IN (
        'acquisition_vm0_source',
        'acquisition_first_party_source'
      )
    ORDER BY "column_row"."column_name"
  `);
  assert.deepEqual(columns.rows, [
    {
      columnDefault: null,
      columnName: "acquisition_first_party_source",
      formattedType: "text",
      hasMissing: false,
      isNullable: "YES",
    },
  ]);

  const bridgeInventory = await client.query<{
    functionCount: number;
    triggerCount: number;
  }>(`
    SELECT
      (
        SELECT count(*)::integer
        FROM "pg_catalog"."pg_proc" AS "function_row"
        INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
          ON "namespace_row"."oid" = "function_row"."pronamespace"
        WHERE "namespace_row"."nspname" = 'public'
          AND "function_row"."proname" =
            'sync_org_metadata_acquisition_first_party_source_1033'
      ) AS "functionCount",
      (
        SELECT count(*)::integer
        FROM "pg_catalog"."pg_trigger"
        WHERE "tgname" =
          'sync_org_metadata_acquisition_first_party_source_1033'
          AND NOT "tgisinternal"
      ) AS "triggerCount"
  `);
  assert.deepEqual(bridgeInventory.rows, [
    { functionCount: 0, triggerCount: 0 },
  ]);

  const primaryKey = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    INNER JOIN "pg_catalog"."pg_index" AS "index_row"
      ON "index_row"."indexrelid" = "constraint_row"."conindid"
    WHERE "constraint_row"."conrelid" = 'public.org_metadata'::regclass
      AND "constraint_row"."conname" = 'org_metadata_pkey'
      AND "constraint_row"."contype" = 'p'
      AND "constraint_row"."convalidated"
      AND NOT "constraint_row"."condeferrable"
      AND pg_catalog.pg_get_constraintdef(
        "constraint_row"."oid", true
      ) = 'PRIMARY KEY (org_id)'
      AND "index_row"."indisunique"
      AND "index_row"."indisprimary"
      AND "index_row"."indisvalid"
      AND "index_row"."indisready"
      AND "index_row"."indpred" IS NULL
      AND "index_row"."indexprs" IS NULL
      AND pg_catalog.pg_get_indexdef("index_row"."indexrelid") =
        'CREATE UNIQUE INDEX org_metadata_pkey ON public.org_metadata USING btree (org_id)'
  `);
  assert.deepEqual(primaryKey.rows, [{ count: 1 }]);
}

async function expectLegacyColumnMissing(client: Client): Promise<void> {
  await client.query("SAVEPOINT expected_legacy_acquisition_column_missing");
  let statementError: unknown;
  try {
    await client.query(
      `SELECT "acquisition_vm0_source" FROM "org_metadata" LIMIT 0`,
    );
  } catch (error) {
    statementError = error;
  }
  await client.query(
    "ROLLBACK TO SAVEPOINT expected_legacy_acquisition_column_missing",
  );
  await client.query(
    "RELEASE SAVEPOINT expected_legacy_acquisition_column_missing",
  );
  assert.equal(databaseErrorField(statementError, "code"), "42703");
}

async function validateCanonicalStatements(
  client: Client,
  prefix: string,
): Promise<void> {
  const bothNullOrgId = `${prefix}-both-null`;
  const canonicalOrgId = `${prefix}-canonical`;

  const bothNull = await client.query<{
    canonical: string | null;
    orgId: string;
  }>(
    `
      INSERT INTO "org_metadata" ("org_id")
      VALUES ($1)
      RETURNING
        "org_id" AS "orgId",
        "acquisition_first_party_source" AS "canonical"
    `,
    [bothNullOrgId],
  );
  assert.deepEqual(bothNull.rows, [{ canonical: null, orgId: bothNullOrgId }]);

  const inserted = await client.query<{
    canonical: string | null;
    orgId: string;
  }>(
    `
      INSERT INTO "org_metadata" (
        "org_id", "acquisition_first_party_source"
      ) VALUES ($1, 'homepage')
      RETURNING
        "org_id" AS "orgId",
        "acquisition_first_party_source" AS "canonical"
    `,
    [canonicalOrgId],
  );
  assert.deepEqual(inserted.rows, [
    { canonical: "homepage", orgId: canonicalOrgId },
  ]);

  const selected = await client.query<{
    canonical: string | null;
    orgId: string;
  }>(
    `
      SELECT
        "org_id" AS "orgId",
        "acquisition_first_party_source" AS "canonical"
      FROM "org_metadata"
      WHERE "org_id" = ANY($1::text[])
      ORDER BY "org_id"
    `,
    [[bothNullOrgId, canonicalOrgId]],
  );
  assert.deepEqual(selected.rows, [
    { canonical: null, orgId: bothNullOrgId },
    { canonical: "homepage", orgId: canonicalOrgId },
  ]);

  const ignored = await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "acquisition_first_party_source"
      ) VALUES ($1, 'marketing')
      ON CONFLICT ("org_id") DO NOTHING
      RETURNING "org_id"
    `,
    [canonicalOrgId],
  );
  assert.equal(ignored.rowCount, 0);

  const upserted = await client.query<{
    canonical: string | null;
    orgId: string;
  }>(
    `
      INSERT INTO "org_metadata" (
        "org_id", "acquisition_first_party_source"
      ) VALUES ($1, 'marketing')
      ON CONFLICT ("org_id") DO UPDATE SET
        "acquisition_first_party_source" =
          EXCLUDED."acquisition_first_party_source"
      RETURNING
        "org_id" AS "orgId",
        "acquisition_first_party_source" AS "canonical"
    `,
    [canonicalOrgId],
  );
  assert.deepEqual(upserted.rows, [
    { canonical: "marketing", orgId: canonicalOrgId },
  ]);

  const updated = await client.query<{
    canonical: string | null;
    orgId: string;
  }>(
    `
      UPDATE "org_metadata"
      SET "acquisition_first_party_source" = 'presentation'
      WHERE "org_id" = $1
      RETURNING
        "org_id" AS "orgId",
        "acquisition_first_party_source" AS "canonical"
    `,
    [canonicalOrgId],
  );
  assert.deepEqual(updated.rows, [
    { canonical: "presentation", orgId: canonicalOrgId },
  ]);

  const locked = await client.query<{
    canonical: string | null;
    orgId: string;
  }>(
    `
      SELECT
        "org_id" AS "orgId",
        "acquisition_first_party_source" AS "canonical"
      FROM "org_metadata"
      WHERE "org_id" = $1
      FOR UPDATE
    `,
    [canonicalOrgId],
  );
  assert.deepEqual(locked.rows, [
    { canonical: "presentation", orgId: canonicalOrgId },
  ]);

  const deleted = await client.query<{ orgId: string }>(
    `
      DELETE FROM "org_metadata"
      WHERE "org_id" = $1
      RETURNING "org_id" AS "orgId"
    `,
    [canonicalOrgId],
  );
  assert.deepEqual(deleted.rows, [{ orgId: canonicalOrgId }]);
}

export async function validatePermanentOrgMetadataAcquisitionFirstPartySourceState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Validate permanent canonical org metadata acquisition first-party source state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await validateCanonicalCatalog(client);
    await client.query("BEGIN");
    try {
      await expectLegacyColumnMissing(client);
      await validateCanonicalStatements(
        client,
        "org-metadata-acquisition-first-party-source-permanent-30985",
      );
    } finally {
      await client.query("ROLLBACK");
    }
    console.log(
      "   ✅ canonical nullable text column and org_id primary key are exact",
    );
    console.log("   ✅ the legacy column and exact 1033 bridge are absent");
    console.log(
      "   ✅ canonical SELECT/INSERT/RETURNING/UPSERT/UPDATE/DELETE/locking statements pass, including NULL\n",
    );
  } finally {
    await client.end();
  }
}
