import assert from "node:assert/strict";
import { Client } from "pg";

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION =
  "1033_org_metadata_acquisition_first_party_source_expand";

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_TRANSITION_TRIGGER = {
  definition:
    "CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033 BEFORE INSERT OR UPDATE OF acquisition_vm0_source, acquisition_first_party_source ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION sync_org_metadata_acquisition_first_party_source_1033()",
  schemaName: "public",
  tableName: "org_metadata",
  triggerName: "sync_org_metadata_acquisition_first_party_source_1033",
} as const;

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_TRANSITION_FUNCTION = {
  bodyHash: "b8a4289a4d44a25fbad45fa87f242680",
  functionName: "sync_org_metadata_acquisition_first_party_source_1033",
  identityArguments: "",
  kind: "f",
  schemaName: "public",
} as const;

const BRIDGE_TRIGGER_NAME =
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_TRANSITION_TRIGGER.triggerName;
const MIRROR_CONSTRAINT_NAME =
  "org_metadata_acquisition_first_party_source_mirror_check";

interface AcquisitionSourceRow {
  readonly canonical: string | null;
  readonly legacy: string | null;
  readonly orgId: string;
}

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

async function readAcquisitionSourceRows(
  client: Client,
  orgIds: readonly string[],
): Promise<readonly AcquisitionSourceRow[]> {
  const result = await client.query<AcquisitionSourceRow>(
    `
      SELECT
        "org_id" AS "orgId",
        "acquisition_vm0_source" AS "legacy",
        "acquisition_first_party_source" AS "canonical"
      FROM "org_metadata"
      WHERE "org_id" = ANY($1::text[])
      ORDER BY "org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

async function validateCatalog(client: Client): Promise<void> {
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
    {
      columnDefault: null,
      columnName: "acquisition_vm0_source",
      formattedType: "text",
      hasMissing: false,
      isNullable: "YES",
    },
  ]);

  await client.query(`SET search_path TO public, pg_catalog`);
  const triggers = await client.query<{
    definition: string;
    enabled: string;
    schemaName: string;
    tableName: string;
    triggerName: string;
  }>(`
    SELECT
      pg_catalog.pg_get_triggerdef("trigger_row"."oid") AS "definition",
      "trigger_row"."tgenabled"::text AS "enabled",
      "namespace_row"."nspname" AS "schemaName",
      "relation_row"."relname" AS "tableName",
      "trigger_row"."tgname" AS "triggerName"
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
      ON "relation_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "relation_row"."relnamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
    ORDER BY "relation_row"."relname", "trigger_row"."tgname"
  `);
  assert.deepEqual(triggers.rows, [
    {
      ...ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_TRANSITION_TRIGGER,
      enabled: "O",
    },
  ]);

  const functions = await client.query<{
    bodyHash: string;
    functionName: string;
    identityArguments: string;
    kind: string;
    ownerName: string;
    schemaName: string;
  }>(`
    SELECT
      pg_catalog.md5("function_row"."prosrc") AS "bodyHash",
      "function_row"."proname" AS "functionName",
      pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
        AS "identityArguments",
      "function_row"."prokind"::text AS "kind",
      pg_catalog.pg_get_userbyid("function_row"."proowner") AS "ownerName",
      "namespace_row"."nspname" AS "schemaName"
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
    ORDER BY pg_catalog.pg_get_function_identity_arguments(
      "function_row"."oid"
    )
  `);
  assert.equal(functions.rows.length, 1);
  assert.deepEqual(
    functions.rows.map(({ ownerName: _, ...row }) => {
      return row;
    }),
    [ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_TRANSITION_FUNCTION],
  );

  const tableOwner = await client.query<{ ownerName: string }>(`
    SELECT pg_catalog.pg_get_userbyid("table_row"."relowner") AS "ownerName"
    FROM "pg_catalog"."pg_class" AS "table_row"
    WHERE "table_row"."oid" = 'public.org_metadata'::regclass
  `);
  assert.equal(functions.rows[0]?.ownerName, tableOwner.rows[0]?.ownerName);
}

async function expectCatalogRejection(
  client: Client,
  savepointName: string,
  mutation: string,
): Promise<void> {
  await client.query(`SAVEPOINT ${savepointName}`);
  try {
    await client.query(mutation);
    await assert.rejects(validateCatalog(client));
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
  }
  await validateCatalog(client);
}

async function validateCatalogInventoryRejection(
  client: Client,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await expectCatalogRejection(
      client,
      "missing_acquisition_bridge",
      `DROP TRIGGER "${BRIDGE_TRIGGER_NAME}" ON "org_metadata"`,
    );
    await expectCatalogRejection(
      client,
      "altered_acquisition_bridge",
      `ALTER TABLE "org_metadata" DISABLE TRIGGER "${BRIDGE_TRIGGER_NAME}"`,
    );
    await expectCatalogRejection(
      client,
      "duplicate_acquisition_bridge_trigger",
      `
        CREATE TRIGGER "${BRIDGE_TRIGGER_NAME}"
        BEFORE INSERT ON "org_plan_entitlements"
        FOR EACH ROW
        EXECUTE FUNCTION public.sync_org_metadata_acquisition_first_party_source_1033()
      `,
    );
    await expectCatalogRejection(
      client,
      "altered_acquisition_bridge_function",
      `
        CREATE OR REPLACE FUNCTION public.sync_org_metadata_acquisition_first_party_source_1033()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $body$
        BEGIN
          RETURN NEW;
        END;
        $body$
      `,
    );
    await expectCatalogRejection(
      client,
      "duplicate_acquisition_bridge_function",
      `
        CREATE FUNCTION public.sync_org_metadata_acquisition_first_party_source_1033(input integer)
        RETURNS integer
        LANGUAGE sql
        IMMUTABLE
        AS $body$ SELECT input $body$
      `,
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectMirrorConstraintViolation(
  client: Client,
  query: string,
  values: readonly string[],
): Promise<void> {
  await client.query("SAVEPOINT expected_acquisition_mirror_violation");
  let statementError: unknown;
  try {
    await client.query(query, [...values]);
  } catch (error) {
    statementError = error;
  }
  await client.query(
    "ROLLBACK TO SAVEPOINT expected_acquisition_mirror_violation",
  );
  await client.query("RELEASE SAVEPOINT expected_acquisition_mirror_violation");
  assert.equal(databaseErrorField(statementError, "code"), "23514");
  assert.equal(
    databaseErrorField(statementError, "constraint"),
    MIRROR_CONSTRAINT_NAME,
  );
}

async function validateInsertPolicy(
  client: Client,
  prefix: string,
): Promise<void> {
  const orgIds = [
    `${prefix}-insert-01-null`,
    `${prefix}-insert-02-legacy`,
    `${prefix}-insert-03-canonical`,
    `${prefix}-insert-04-equal`,
    `${prefix}-insert-05-conflict`,
  ] as const;

  await client.query(
    `INSERT INTO "org_metadata" ("org_id", "credits") VALUES ($1, 0)`,
    [orgIds[0]],
  );
  await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "acquisition_vm0_source"
      ) VALUES ($1, 0, 'homepage')
    `,
    [orgIds[1]],
  );
  await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "acquisition_first_party_source"
      ) VALUES ($1, 0, 'marketing')
    `,
    [orgIds[2]],
  );
  await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "acquisition_vm0_source",
        "acquisition_first_party_source"
      ) VALUES ($1, 0, 'presentation', 'presentation')
    `,
    [orgIds[3]],
  );
  await expectMirrorConstraintViolation(
    client,
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "acquisition_vm0_source",
        "acquisition_first_party_source"
      ) VALUES ($1, 0, 'homepage', 'marketing')
    `,
    [orgIds[4]],
  );

  assert.deepEqual(await readAcquisitionSourceRows(client, orgIds), [
    { canonical: null, legacy: null, orgId: orgIds[0] },
    { canonical: "homepage", legacy: "homepage", orgId: orgIds[1] },
    { canonical: "marketing", legacy: "marketing", orgId: orgIds[2] },
    {
      canonical: "presentation",
      legacy: "presentation",
      orgId: orgIds[3],
    },
  ]);
}

async function seedLegacyOnlyRow(client: Client, orgId: string): Promise<void> {
  await client.query(
    `ALTER TABLE "org_metadata" DISABLE TRIGGER "${BRIDGE_TRIGGER_NAME}"`,
  );
  try {
    await client.query(
      `
        INSERT INTO "org_metadata" (
          "org_id", "credits", "acquisition_vm0_source"
        ) VALUES ($1, 0, 'homepage')
      `,
      [orgId],
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_metadata" ENABLE TRIGGER "${BRIDGE_TRIGGER_NAME}"`,
    );
  }
}

async function validateUpdatePolicy(
  client: Client,
  prefix: string,
): Promise<void> {
  const legacyOnlyOrgId = `${prefix}-update-01-legacy-only`;
  const nullLegacyWriteOrgId = `${prefix}-update-02-null-legacy-write`;
  const nullCanonicalWriteOrgId = `${prefix}-update-03-null-canonical-write`;
  const equalOrgId = `${prefix}-update-04-equal`;
  await seedLegacyOnlyRow(client, legacyOnlyOrgId);
  await client.query(
    `INSERT INTO "org_metadata" ("org_id", "credits") VALUES ($1, 0), ($2, 0)`,
    [nullLegacyWriteOrgId, nullCanonicalWriteOrgId],
  );
  await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "acquisition_vm0_source"
      ) VALUES ($1, 0, 'presentation')
    `,
    [equalOrgId],
  );

  const originalRows = await readAcquisitionSourceRows(client, [
    equalOrgId,
    legacyOnlyOrgId,
    nullCanonicalWriteOrgId,
    nullLegacyWriteOrgId,
  ]);
  await client.query(
    `
      UPDATE "org_metadata"
      SET "onboarding_complete" = NOT "onboarding_complete"
      WHERE "org_id" = ANY($1::text[])
    `,
    [
      [
        equalOrgId,
        legacyOnlyOrgId,
        nullCanonicalWriteOrgId,
        nullLegacyWriteOrgId,
      ],
    ],
  );
  assert.deepEqual(
    await readAcquisitionSourceRows(client, [
      equalOrgId,
      legacyOnlyOrgId,
      nullCanonicalWriteOrgId,
      nullLegacyWriteOrgId,
    ]),
    originalRows,
  );

  await client.query(
    `
      UPDATE "org_metadata"
      SET "acquisition_vm0_source" = "acquisition_vm0_source"
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  await client.query(
    `
      UPDATE "org_metadata"
      SET "acquisition_first_party_source" =
        "acquisition_first_party_source"
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  assert.deepEqual(await readAcquisitionSourceRows(client, [legacyOnlyOrgId]), [
    { canonical: null, legacy: "homepage", orgId: legacyOnlyOrgId },
  ]);

  await client.query(
    `
      UPDATE "org_metadata"
      SET "acquisition_vm0_source" = 'marketing'
      WHERE "org_id" = $1
    `,
    [nullLegacyWriteOrgId],
  );
  await client.query(
    `
      UPDATE "org_metadata"
      SET "acquisition_first_party_source" = 'web_design'
      WHERE "org_id" = $1
    `,
    [nullCanonicalWriteOrgId],
  );
  assert.deepEqual(
    await readAcquisitionSourceRows(client, [
      nullCanonicalWriteOrgId,
      nullLegacyWriteOrgId,
    ]),
    [
      {
        canonical: "marketing",
        legacy: "marketing",
        orgId: nullLegacyWriteOrgId,
      },
      {
        canonical: "web_design",
        legacy: "web_design",
        orgId: nullCanonicalWriteOrgId,
      },
    ],
  );

  await client.query(
    `
      UPDATE "org_metadata"
      SET
        "acquisition_vm0_source" = 'video',
        "acquisition_first_party_source" = 'video'
      WHERE "org_id" = $1
    `,
    [equalOrgId],
  );
  assert.deepEqual(await readAcquisitionSourceRows(client, [equalOrgId]), [
    { canonical: "video", legacy: "video", orgId: equalOrgId },
  ]);

  await expectMirrorConstraintViolation(
    client,
    `
      UPDATE "org_metadata"
      SET
        "acquisition_vm0_source" = 'homepage',
        "acquisition_first_party_source" = 'marketing'
      WHERE "org_id" = $1
    `,
    [equalOrgId],
  );
  await expectMirrorConstraintViolation(
    client,
    `
      UPDATE "org_metadata"
      SET "acquisition_vm0_source" = NULL
      WHERE "org_id" = $1
    `,
    [equalOrgId],
  );
  await expectMirrorConstraintViolation(
    client,
    `
      UPDATE "org_metadata"
      SET "acquisition_first_party_source" = NULL
      WHERE "org_id" = $1
    `,
    [equalOrgId],
  );
  assert.deepEqual(await readAcquisitionSourceRows(client, [equalOrgId]), [
    { canonical: "video", legacy: "video", orgId: equalOrgId },
  ]);

  const conflictResult = await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "acquisition_vm0_source"
      ) VALUES ($1, 0, 'calendar')
      ON CONFLICT ("org_id") DO NOTHING
      RETURNING "org_id"
    `,
    [equalOrgId],
  );
  assert.equal(conflictResult.rowCount, 0);
  assert.deepEqual(await readAcquisitionSourceRows(client, [equalOrgId]), [
    { canonical: "video", legacy: "video", orgId: equalOrgId },
  ]);

  const locked = await client.query<AcquisitionSourceRow>(
    `
      SELECT
        "org_id" AS "orgId",
        "acquisition_vm0_source" AS "legacy",
        "acquisition_first_party_source" AS "canonical"
      FROM "org_metadata"
      WHERE "org_id" = $1
      FOR UPDATE
    `,
    [equalOrgId],
  );
  assert.deepEqual(locked.rows, [
    { canonical: "video", legacy: "video", orgId: equalOrgId },
  ]);
}

async function validateBehavior(client: Client, prefix: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await validateInsertPolicy(client, prefix);
    await validateUpdatePolicy(client, prefix);

    const mismatches = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "org_metadata"
        WHERE "org_id" LIKE $1
          AND "acquisition_vm0_source" IS DISTINCT FROM
            "acquisition_first_party_source"
      `,
      [`${prefix}-%`],
    );
    assert.deepEqual(mismatches.rows, [{ count: 1 }]);
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function installOrgMetadataAcquisitionFirstPartySourceArtifactsOnRegeneratedSchema(
  dbUrl: string,
  migrationSql: string,
): Promise<void> {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  assert.equal(statements.length, 5);
  assert.match(statements[0] ?? "", /^DO \$\$/u);
  assert.equal(
    statements[1],
    'ALTER TABLE "org_metadata" ADD COLUMN "acquisition_first_party_source" text;',
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // Recreate the accepted 1033 catalog on a fresh canonical schema so the
    // regenerated-schema replay still proves the historical transition.
    await client.query(`
      ALTER TABLE "org_metadata"
      ADD COLUMN "acquisition_vm0_source" text
    `);
    for (const statement of statements.slice(2)) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

export async function validateTransitionOrgMetadataAcquisitionFirstPartySourceState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Validate historical org metadata acquisition first-party source transition state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await validateCatalog(client);
    await validateCatalogInventoryRejection(client);
    await validateBehavior(
      client,
      "org-metadata-acquisition-first-party-source-transition-30379",
    );
    console.log("   ✅ nullable text columns and bridge catalog are exact");
    console.log(
      "   ✅ missing, altered, duplicated, and unexpected bridge objects fail inventory",
    );
    console.log(
      "   ✅ old/new writes mirror while conflicts and one-sided NULLs fail atomically\n",
    );
  } finally {
    await client.end();
  }
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
