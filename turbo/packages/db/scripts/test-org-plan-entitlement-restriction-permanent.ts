import assert from "node:assert/strict";
import { Client } from "pg";

export const ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION =
  "1023_org_plan_entitlement_restriction_expand";

export const ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER = {
  definition:
    "CREATE TRIGGER sync_org_plan_entitlement_model_restrictions_1023 BEFORE INSERT OR UPDATE OF restricted_vm0_models, restricted_built_in_models ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION sync_org_plan_entitlement_model_restrictions_1023()",
  schemaName: "public",
  tableName: "org_plan_entitlements",
  triggerName: "sync_org_plan_entitlement_model_restrictions_1023",
} as const;

export const ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION = {
  bodyHash: "c46d67f828e6890bedef54daade5ce43",
  functionName: "sync_org_plan_entitlement_model_restrictions_1023",
  identityArguments: "",
  kind: "f",
  schemaName: "public",
} as const;

export const ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION = {
  bodyHash: "d51c688124a37d0fe34bbabcc8568e97",
  functionName: "ensure_legacy_org_metadata_plan_entitlement",
  identityArguments: "",
  kind: "f",
  schemaName: "public",
} as const;

const BRIDGE_TRIGGER_NAME =
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER.triggerName;
const MIRROR_CONSTRAINT_NAME =
  "org_plan_entitlements_model_restriction_mirror_check";

interface RestrictionRow {
  readonly canonical: boolean | null;
  readonly legacy: boolean;
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

async function readRestrictionRows(
  client: Client,
  orgIds: readonly string[],
): Promise<readonly RestrictionRow[]> {
  const result = await client.query<RestrictionRow>(
    `
      SELECT
        "org_id" AS "orgId",
        "restricted_vm0_models" AS "legacy",
        "restricted_built_in_models" AS "canonical"
      FROM "org_plan_entitlements"
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
      ON "attribute_row"."attrelid" =
        'public.org_plan_entitlements'::regclass
      AND "attribute_row"."attname" = "column_row"."column_name"
      AND NOT "attribute_row"."attisdropped"
    WHERE "column_row"."table_schema" = 'public'
      AND "column_row"."table_name" = 'org_plan_entitlements'
      AND "column_row"."column_name" IN (
        'restricted_vm0_models',
        'restricted_built_in_models'
      )
    ORDER BY "column_row"."column_name"
  `);
  assert.deepEqual(columns.rows, [
    {
      columnDefault: null,
      columnName: "restricted_built_in_models",
      formattedType: "boolean",
      hasMissing: false,
      isNullable: "YES",
    },
    {
      columnDefault: "true",
      columnName: "restricted_vm0_models",
      formattedType: "boolean",
      hasMissing: false,
      isNullable: "NO",
    },
  ]);

  await client.query(`SET search_path TO public, pg_catalog`);
  const triggers = await client.query<{
    definition: string;
    schemaName: string;
    tableName: string;
    triggerName: string;
  }>(`
    SELECT
      "namespace_row"."nspname" AS "schemaName",
      "relation_row"."relname" AS "tableName",
      "trigger_row"."tgname" AS "triggerName",
      pg_catalog.pg_get_triggerdef("trigger_row"."oid") AS "definition"
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "relation_row"
      ON "relation_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "relation_row"."relnamespace"
    WHERE NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgname" IN (
        'ensure_legacy_org_metadata_plan_entitlement',
        'sync_org_plan_entitlement_model_restrictions_1023'
      )
    ORDER BY "trigger_row"."tgname"
  `);
  assert.deepEqual(triggers.rows, [
    {
      definition:
        "CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION ensure_legacy_org_metadata_plan_entitlement()",
      schemaName: "public",
      tableName: "org_metadata",
      triggerName: "ensure_legacy_org_metadata_plan_entitlement",
    },
    ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER,
  ]);

  const functions = await client.query<{
    bodyHash: string;
    definition: string;
    functionName: string;
    identityArguments: string;
    kind: string;
    ownerName: string;
    schemaName: string;
  }>(`
    SELECT
      pg_catalog.md5("function_row"."prosrc") AS "bodyHash",
      pg_catalog.pg_get_functiondef("function_row"."oid") AS "definition",
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
      AND "function_row"."proname" IN (
        'ensure_legacy_org_metadata_plan_entitlement',
        'sync_org_plan_entitlement_model_restrictions_1023'
      )
    ORDER BY "function_row"."proname"
  `);
  assert.equal(functions.rows.length, 2);
  const functionCatalog = functions.rows.map((row) => {
    return {
      bodyHash: row.bodyHash,
      functionName: row.functionName,
      identityArguments: row.identityArguments,
      kind: row.kind,
      schemaName: row.schemaName,
    };
  });
  assert.deepEqual(functionCatalog, [
    ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION,
    ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION,
  ]);
  assert.equal(functions.rows[0]?.ownerName, functions.rows[1]?.ownerName);
  assert.match(
    functions.rows[0]?.definition ?? "",
    /"restricted_built_in_models"/u,
  );
  assert.match(
    functions.rows[1]?.definition ?? "",
    /IF NEW\."restricted_built_in_models" IS NULL THEN/u,
  );
}

async function expectMirrorConstraintViolation(
  client: Client,
  query: string,
  values: readonly string[],
): Promise<void> {
  await client.query("SAVEPOINT expected_mirror_constraint_violation");
  let statementError: unknown;
  try {
    await client.query(query, [...values]);
  } catch (error) {
    statementError = error;
  }
  await client.query(
    "ROLLBACK TO SAVEPOINT expected_mirror_constraint_violation",
  );
  await client.query("RELEASE SAVEPOINT expected_mirror_constraint_violation");
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
    `${prefix}-insert-01-omitted`,
    `${prefix}-insert-02-legacy`,
    `${prefix}-insert-03-canonical`,
    `${prefix}-insert-04-equal`,
    `${prefix}-insert-05-conflict-canonical-true`,
    `${prefix}-insert-06-conflict-canonical-false`,
  ] as const;

  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source"
      ) VALUES ($1, 'fixture', 0, 'test_fixture')
    `,
    [orgIds[0]],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
    `,
    [orgIds[1]],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
    `,
    [orgIds[2]],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models", "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true, true)
    `,
    [orgIds[3]],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models", "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', false, true)
    `,
    [orgIds[4]],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models", "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true, false)
    `,
    [orgIds[5]],
  );

  assert.deepEqual(await readRestrictionRows(client, orgIds), [
    { canonical: true, legacy: true, orgId: orgIds[0] },
    { canonical: false, legacy: false, orgId: orgIds[1] },
    { canonical: false, legacy: false, orgId: orgIds[2] },
    { canonical: true, legacy: true, orgId: orgIds[3] },
    { canonical: true, legacy: true, orgId: orgIds[4] },
    { canonical: false, legacy: false, orgId: orgIds[5] },
  ]);
}

async function seedLegacyOnlyRow(client: Client, orgId: string): Promise<void> {
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true)
    `,
    [orgId],
  );
  await client.query(
    `ALTER TABLE "org_plan_entitlements" DISABLE TRIGGER "${BRIDGE_TRIGGER_NAME}"`,
  );
  try {
    await client.query(
      `
        UPDATE "org_plan_entitlements"
        SET "restricted_built_in_models" = NULL
        WHERE "org_id" = $1
      `,
      [orgId],
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "${BRIDGE_TRIGGER_NAME}"`,
    );
  }
}

async function validateUpdatePolicy(
  client: Client,
  prefix: string,
): Promise<void> {
  const legacyOnlyOrgId = `${prefix}-update-legacy-only`;
  await seedLegacyOnlyRow(client, legacyOnlyOrgId);

  await client.query(
    `UPDATE "org_plan_entitlements" SET "status" = 'suspended' WHERE "org_id" = $1`,
    [legacyOnlyOrgId],
  );
  await client.query(
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_vm0_models" = "restricted_vm0_models"
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  await client.query(
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_built_in_models" = "restricted_built_in_models"
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  assert.deepEqual(await readRestrictionRows(client, [legacyOnlyOrgId]), [
    { canonical: null, legacy: true, orgId: legacyOnlyOrgId },
  ]);

  await expectMirrorConstraintViolation(
    client,
    `
      UPDATE "org_plan_entitlements"
      SET
        "restricted_vm0_models" = false,
        "restricted_built_in_models" = true
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  assert.deepEqual(await readRestrictionRows(client, [legacyOnlyOrgId]), [
    { canonical: null, legacy: true, orgId: legacyOnlyOrgId },
  ]);

  await client.query(
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_vm0_models" = false
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  assert.deepEqual(await readRestrictionRows(client, [legacyOnlyOrgId]), [
    { canonical: false, legacy: false, orgId: legacyOnlyOrgId },
  ]);

  await client.query(
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_built_in_models" = true
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  assert.deepEqual(await readRestrictionRows(client, [legacyOnlyOrgId]), [
    { canonical: true, legacy: true, orgId: legacyOnlyOrgId },
  ]);

  await expectMirrorConstraintViolation(
    client,
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_built_in_models" = NULL
      WHERE "org_id" = $1
    `,
    [legacyOnlyOrgId],
  );
  assert.deepEqual(await readRestrictionRows(client, [legacyOnlyOrgId]), [
    { canonical: true, legacy: true, orgId: legacyOnlyOrgId },
  ]);
}

async function validateConflictWrites(
  client: Client,
  prefix: string,
): Promise<void> {
  const legacyOrgId = `${prefix}-conflict-legacy`;
  const canonicalOrgId = `${prefix}-conflict-canonical`;

  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
      ON CONFLICT ("org_id") DO UPDATE SET
        "restricted_vm0_models" = EXCLUDED."restricted_vm0_models"
    `,
    [legacyOrgId],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true)
      ON CONFLICT ("org_id") DO UPDATE SET
        "restricted_vm0_models" = EXCLUDED."restricted_vm0_models"
    `,
    [legacyOrgId],
  );

  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
      ON CONFLICT ("org_id") DO UPDATE SET
        "restricted_built_in_models" =
          EXCLUDED."restricted_built_in_models"
    `,
    [canonicalOrgId],
  );
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true)
      ON CONFLICT ("org_id") DO UPDATE SET
        "restricted_built_in_models" =
          EXCLUDED."restricted_built_in_models"
    `,
    [canonicalOrgId],
  );

  assert.deepEqual(
    await readRestrictionRows(client, [canonicalOrgId, legacyOrgId]),
    [
      { canonical: true, legacy: true, orgId: canonicalOrgId },
      { canonical: true, legacy: true, orgId: legacyOrgId },
    ],
  );

  await client.query(
    `DELETE FROM "org_plan_entitlements" WHERE "org_id" = $1`,
    [canonicalOrgId],
  );
  assert.deepEqual(await readRestrictionRows(client, [canonicalOrgId]), []);
}

async function validateOrgMetadataHelper(
  client: Client,
  prefix: string,
): Promise<void> {
  const tiers = [
    "free",
    "limited-free-1",
    "pro-suspend",
    "pro",
    "team",
    "custom",
  ] as const;
  for (const tier of tiers) {
    await client.query(
      `INSERT INTO "org_metadata" ("org_id", "tier", "credits") VALUES ($1, $2, 0)`,
      [`${prefix}-helper-${tier}`, tier],
    );
  }

  const rows = await client.query<{
    audioDailyDurationSeconds: number;
    audioDailyRateLimit: number;
    audioLifetimeLimit: number | null;
    autoRechargeAllowed: boolean;
    baseConcurrencyLimit: number;
    canBuyConcurrency: boolean;
    canBuyCredits: boolean;
    canonical: boolean;
    legacy: boolean;
    planKey: string;
    planRank: number;
    source: string;
    status: string;
    supportByok: boolean;
    videoGenerationAllowed: boolean;
    workflowWebhookTriggerAllowed: boolean;
  }>(
    `
      SELECT
        "plan_key" AS "planKey",
        "plan_rank" AS "planRank",
        "source",
        "status",
        "base_concurrency_limit" AS "baseConcurrencyLimit",
        "can_buy_concurrency" AS "canBuyConcurrency",
        "can_buy_credits" AS "canBuyCredits",
        "auto_recharge_allowed" AS "autoRechargeAllowed",
        "support_byok" AS "supportByok",
        "restricted_vm0_models" AS "legacy",
        "restricted_built_in_models" AS "canonical",
        "video_generation_allowed" AS "videoGenerationAllowed",
        "workflow_webhook_trigger_allowed"
          AS "workflowWebhookTriggerAllowed",
        "audio_lifetime_limit" AS "audioLifetimeLimit",
        "audio_daily_rate_limit" AS "audioDailyRateLimit",
        "audio_daily_duration_seconds" AS "audioDailyDurationSeconds"
      FROM "org_plan_entitlements"
      WHERE "org_id" LIKE $1
      ORDER BY array_position($2::text[], "plan_key")
    `,
    [`${prefix}-helper-%`, [...tiers]],
  );
  assert.deepEqual(rows.rows, [
    {
      audioDailyDurationSeconds: 600,
      audioDailyRateLimit: 10,
      audioLifetimeLimit: 10,
      autoRechargeAllowed: false,
      baseConcurrencyLimit: 1,
      canBuyConcurrency: false,
      canBuyCredits: true,
      canonical: false,
      legacy: false,
      planKey: "free",
      planRank: 0,
      source: "org_metadata_migration",
      status: "active",
      supportByok: true,
      videoGenerationAllowed: true,
      workflowWebhookTriggerAllowed: false,
    },
    {
      audioDailyDurationSeconds: 600,
      audioDailyRateLimit: 10,
      audioLifetimeLimit: 10,
      autoRechargeAllowed: false,
      baseConcurrencyLimit: 1,
      canBuyConcurrency: false,
      canBuyCredits: false,
      canonical: true,
      legacy: true,
      planKey: "limited-free-1",
      planRank: 0,
      source: "org_metadata_migration",
      status: "active",
      supportByok: false,
      videoGenerationAllowed: false,
      workflowWebhookTriggerAllowed: false,
    },
    {
      audioDailyDurationSeconds: 0,
      audioDailyRateLimit: 0,
      audioLifetimeLimit: 0,
      autoRechargeAllowed: false,
      baseConcurrencyLimit: 0,
      canBuyConcurrency: false,
      canBuyCredits: false,
      canonical: true,
      legacy: true,
      planKey: "pro-suspend",
      planRank: 0,
      source: "org_metadata_migration",
      status: "suspended",
      supportByok: false,
      videoGenerationAllowed: false,
      workflowWebhookTriggerAllowed: false,
    },
    {
      audioDailyDurationSeconds: 12_000,
      audioDailyRateLimit: 300,
      audioLifetimeLimit: null,
      autoRechargeAllowed: true,
      baseConcurrencyLimit: 2,
      canBuyConcurrency: false,
      canBuyCredits: true,
      canonical: false,
      legacy: false,
      planKey: "pro",
      planRank: 1,
      source: "org_metadata_migration",
      status: "active",
      supportByok: true,
      videoGenerationAllowed: true,
      workflowWebhookTriggerAllowed: false,
    },
    {
      audioDailyDurationSeconds: 30_000,
      audioDailyRateLimit: 500,
      audioLifetimeLimit: null,
      autoRechargeAllowed: true,
      baseConcurrencyLimit: 10,
      canBuyConcurrency: true,
      canBuyCredits: true,
      canonical: false,
      legacy: false,
      planKey: "team",
      planRank: 2,
      source: "org_metadata_migration",
      status: "active",
      supportByok: true,
      videoGenerationAllowed: true,
      workflowWebhookTriggerAllowed: true,
    },
    {
      audioDailyDurationSeconds: 30_000,
      audioDailyRateLimit: 500,
      audioLifetimeLimit: null,
      autoRechargeAllowed: true,
      baseConcurrencyLimit: 10,
      canBuyConcurrency: true,
      canBuyCredits: true,
      canonical: false,
      legacy: false,
      planKey: "custom",
      planRank: 3,
      source: "org_metadata_migration",
      status: "active",
      supportByok: true,
      videoGenerationAllowed: true,
      workflowWebhookTriggerAllowed: true,
    },
  ]);

  const conflictOrgId = `${prefix}-helper-conflict`;
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models"
      ) VALUES ($1, 'preserved', 99, 'test_fixture', true)
    `,
    [conflictOrgId],
  );
  await client.query(
    `INSERT INTO "org_metadata" ("org_id", "tier", "credits") VALUES ($1, 'team', 0)`,
    [conflictOrgId],
  );
  const conflict = await client.query<{
    canonical: boolean;
    count: number;
    legacy: boolean;
    planKey: string;
    source: string;
  }>(
    `
      SELECT
        count(*) OVER ()::integer AS "count",
        "plan_key" AS "planKey",
        "source",
        "restricted_vm0_models" AS "legacy",
        "restricted_built_in_models" AS "canonical"
      FROM "org_plan_entitlements"
      WHERE "org_id" = $1
    `,
    [conflictOrgId],
  );
  assert.deepEqual(conflict.rows, [
    {
      canonical: true,
      count: 1,
      legacy: true,
      planKey: "preserved",
      source: "test_fixture",
    },
  ]);
}

async function validateBehavior(client: Client, prefix: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await validateInsertPolicy(client, prefix);
    await validateUpdatePolicy(client, prefix);
    await validateConflictWrites(client, prefix);
    await validateOrgMetadataHelper(client, prefix);

    const unequal = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "org_plan_entitlements"
        WHERE "org_id" LIKE $1
          AND "restricted_built_in_models" IS NOT NULL
          AND "restricted_built_in_models" IS DISTINCT FROM
            "restricted_vm0_models"
      `,
      [`${prefix}-%`],
    );
    assert.deepEqual(unequal.rows, [{ count: 0 }]);
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function installOrgPlanEntitlementRestrictionArtifactsOnRegeneratedSchema(
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
  assert.equal(statements.length, 4);
  assert.match(
    statements[0] ?? "",
    /^ALTER TABLE "org_plan_entitlements" ADD COLUMN/u,
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const statement of statements.slice(1)) {
      await client.query(statement);
    }
    await client.query(`
      CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement
      AFTER INSERT ON public.org_metadata
      FOR EACH ROW
      EXECUTE FUNCTION public.ensure_legacy_org_metadata_plan_entitlement()
    `);
  } finally {
    await client.end();
  }
}

export async function validatePermanentOrgPlanEntitlementRestrictionState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1.3: Validate permanent org plan entitlement restriction state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await validateCatalog(client);
    await validateBehavior(client, "org-plan-restriction-permanent-30162");
    console.log("   ✅ legacy default and canonical precedence are exact");
    console.log("   ✅ one-sided updates mirror and conflicts fail atomically");
    console.log(
      "   ✅ helper tier values and ON CONFLICT behavior are preserved\n",
    );
  } finally {
    await client.end();
  }
}
