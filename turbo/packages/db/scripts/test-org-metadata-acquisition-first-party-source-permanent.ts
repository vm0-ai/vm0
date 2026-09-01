import assert from "node:assert/strict";
import { Client } from "pg";

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION =
  "1033_org_metadata_acquisition_first_party_source_expand";

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER = {
  definition:
    "CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033 BEFORE INSERT OR UPDATE OF acquisition_vm0_source, acquisition_first_party_source ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION sync_org_metadata_acquisition_first_party_source_1033()",
  schemaName: "public",
  tableName: "org_metadata",
  triggerName: "sync_org_metadata_acquisition_first_party_source_1033",
} as const;

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION = {
  bodyHash: "b8a4289a4d44a25fbad45fa87f242680",
  functionName: "sync_org_metadata_acquisition_first_party_source_1033",
  identityArguments: "",
  kind: "f",
  schemaName: "public",
} as const;

const BRIDGE_TRIGGER_NAME =
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER.triggerName;
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
      ...ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER,
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
    [ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION],
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
    for (const statement of statements.slice(2)) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

export async function validatePermanentOrgMetadataAcquisitionFirstPartySourceState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Validate permanent org metadata acquisition first-party source state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await validateCatalog(client);
    await validateCatalogInventoryRejection(client);
    await validateBehavior(
      client,
      "org-metadata-acquisition-first-party-source-permanent-30379",
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
