import assert from "node:assert/strict";
import { Client } from "pg";

export const ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION = {
  bodyHash: "0b0d44031a51ffc349f0f33cb0df53c3",
  functionName: "ensure_legacy_org_metadata_plan_entitlement",
  identityArguments: "",
  kind: "f",
  schemaName: "public",
} as const;

function databaseErrorField(
  error: unknown,
  field: "code" | "column" | "constraint",
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
  ]);

  const functions = await client.query<{
    bodyHash: string;
    definition: string;
    functionName: string;
    identityArguments: string;
    kind: string;
    languageName: string;
    ownerName: string;
    parallelSafety: string;
    runtimeConfig: readonly string[] | null;
    schemaName: string;
    securityDefiner: boolean;
    strict: boolean;
    volatility: string;
  }>(`
    SELECT
      pg_catalog.md5("function_row"."prosrc") AS "bodyHash",
      pg_catalog.pg_get_functiondef("function_row"."oid") AS "definition",
      "function_row"."proname" AS "functionName",
      pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
        AS "identityArguments",
      "function_row"."prokind"::text AS "kind",
      "language_row"."lanname" AS "languageName",
      pg_catalog.pg_get_userbyid("function_row"."proowner") AS "ownerName",
      "function_row"."proparallel"::text AS "parallelSafety",
      "function_row"."proconfig" AS "runtimeConfig",
      "namespace_row"."nspname" AS "schemaName",
      "function_row"."prosecdef" AS "securityDefiner",
      "function_row"."proisstrict" AS "strict",
      "function_row"."provolatile"::text AS "volatility"
    FROM "pg_catalog"."pg_proc" AS "function_row"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
      ON "namespace_row"."oid" = "function_row"."pronamespace"
    INNER JOIN "pg_catalog"."pg_language" AS "language_row"
      ON "language_row"."oid" = "function_row"."prolang"
    WHERE "namespace_row"."nspname" = 'public'
      AND "function_row"."proname" IN (
        'ensure_legacy_org_metadata_plan_entitlement',
        'sync_org_plan_entitlement_model_restrictions_1023'
      )
    ORDER BY "function_row"."proname"
  `);
  assert.equal(functions.rows.length, 1);
  const helper = functions.rows[0];
  assert.ok(helper);
  assert.deepEqual(
    {
      bodyHash: helper.bodyHash,
      functionName: helper.functionName,
      identityArguments: helper.identityArguments,
      kind: helper.kind,
      schemaName: helper.schemaName,
    },
    ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION,
  );
  assert.deepEqual(
    {
      languageName: helper.languageName,
      parallelSafety: helper.parallelSafety,
      runtimeConfig: helper.runtimeConfig,
      securityDefiner: helper.securityDefiner,
      strict: helper.strict,
      volatility: helper.volatility,
    },
    {
      languageName: "plpgsql",
      parallelSafety: "u",
      runtimeConfig: null,
      securityDefiner: false,
      strict: false,
      volatility: "v",
    },
  );
  assert.match(helper.definition, /"restricted_built_in_models"/u);
  assert.match(helper.definition, /ON CONFLICT \("org_id"\) DO NOTHING/u);
  assert.doesNotMatch(helper.definition, /restricted_vm0_models/u);

  const owner = await client.query<{ ownerName: string }>(`
    SELECT pg_catalog.pg_get_userbyid("relation_row"."relowner") AS "ownerName"
    FROM "pg_catalog"."pg_class" AS "relation_row"
    WHERE "relation_row"."oid" = 'public.org_metadata'::regclass
  `);
  assert.equal(helper.ownerName, owner.rows[0]?.ownerName);

  const primaryKey = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS "count"
    FROM "pg_catalog"."pg_constraint" AS "constraint_row"
    INNER JOIN "pg_catalog"."pg_index" AS "index_row"
      ON "index_row"."indexrelid" = "constraint_row"."conindid"
    WHERE "constraint_row"."conrelid" =
        'public.org_plan_entitlements'::regclass
      AND "constraint_row"."conname" = 'org_plan_entitlements_pkey'
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
        'CREATE UNIQUE INDEX org_plan_entitlements_pkey ON public.org_plan_entitlements USING btree (org_id)'
  `);
  assert.deepEqual(primaryKey.rows, [{ count: 1 }]);
}

async function expectCanonicalNotNullViolation(
  client: Client,
  orgId: string,
): Promise<void> {
  await client.query("SAVEPOINT expected_canonical_not_null_violation");
  let statementError: unknown;
  try {
    await client.query(
      `
        INSERT INTO "org_plan_entitlements" (
          "org_id", "plan_key", "plan_rank", "source"
        ) VALUES ($1, 'fixture', 0, 'test_fixture')
      `,
      [orgId],
    );
  } catch (error) {
    statementError = error;
  }
  await client.query(
    "ROLLBACK TO SAVEPOINT expected_canonical_not_null_violation",
  );
  await client.query("RELEASE SAVEPOINT expected_canonical_not_null_violation");
  assert.equal(databaseErrorField(statementError, "code"), "23502");
  assert.equal(
    databaseErrorField(statementError, "column"),
    "restricted_built_in_models",
  );
}

async function validateCanonicalStatements(
  client: Client,
  prefix: string,
): Promise<void> {
  const orgId = `${prefix}-statements`;
  const inserted = await client.query<{
    canonical: boolean;
    orgId: string;
  }>(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
      RETURNING
        "org_id" AS "orgId",
        "restricted_built_in_models" AS "canonical"
    `,
    [orgId],
  );
  assert.deepEqual(inserted.rows, [{ canonical: false, orgId }]);

  const selected = await client.query<{ canonical: boolean; orgId: string }>(
    `
      SELECT
        "org_id" AS "orgId",
        "restricted_built_in_models" AS "canonical"
      FROM "org_plan_entitlements"
      WHERE "org_id" = $1
    `,
    [orgId],
  );
  assert.deepEqual(selected.rows, [{ canonical: false, orgId }]);

  const upserted = await client.query<{ canonical: boolean; orgId: string }>(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true)
      ON CONFLICT ("org_id") DO UPDATE SET
        "restricted_built_in_models" =
          EXCLUDED."restricted_built_in_models"
      RETURNING
        "org_id" AS "orgId",
        "restricted_built_in_models" AS "canonical"
    `,
    [orgId],
  );
  assert.deepEqual(upserted.rows, [{ canonical: true, orgId }]);

  const updated = await client.query<{ canonical: boolean; orgId: string }>(
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_built_in_models" = false
      WHERE "org_id" = $1
      RETURNING
        "org_id" AS "orgId",
        "restricted_built_in_models" AS "canonical"
    `,
    [orgId],
  );
  assert.deepEqual(updated.rows, [{ canonical: false, orgId }]);

  const locked = await client.query<{ canonical: boolean; orgId: string }>(
    `
      SELECT
        "org_id" AS "orgId",
        "restricted_built_in_models" AS "canonical"
      FROM "org_plan_entitlements"
      WHERE "org_id" = $1
      FOR UPDATE
    `,
    [orgId],
  );
  assert.deepEqual(locked.rows, [{ canonical: false, orgId }]);

  const deleted = await client.query<{ orgId: string }>(
    `
      DELETE FROM "org_plan_entitlements"
      WHERE "org_id" = $1
      RETURNING "org_id" AS "orgId"
    `,
    [orgId],
  );
  assert.deepEqual(deleted.rows, [{ orgId }]);

  await expectCanonicalNotNullViolation(client, `${prefix}-missing-canonical`);
}

interface CanonicalTierRow {
  readonly audioDailyDurationSeconds: number;
  readonly audioDailyRateLimit: number;
  readonly audioLifetimeLimit: number | null;
  readonly autoRechargeAllowed: boolean;
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly canonical: boolean;
  readonly planKey: string;
  readonly planRank: number;
  readonly source: string;
  readonly status: string;
  readonly supportByok: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookTriggerAllowed: boolean;
}

async function validateCanonicalOrgMetadataHelper(
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

  const rows = await client.query<CanonicalTierRow>(
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
        "restricted_built_in_models"
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
    planKey: string;
    source: string;
  }>(
    `
      SELECT
        count(*) OVER ()::integer AS "count",
        "plan_key" AS "planKey",
        "source",
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
      planKey: "preserved",
      source: "test_fixture",
    },
  ]);
}

export async function validatePermanentOrgPlanEntitlementRestrictionState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1.3: Validate permanent canonical org plan entitlement restriction state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await validateCanonicalCatalog(client);
    await client.query("BEGIN");
    try {
      await validateCanonicalStatements(
        client,
        "org-plan-restriction-permanent-30757",
      );
      await validateCanonicalOrgMetadataHelper(
        client,
        "org-plan-restriction-permanent-30757",
      );
    } finally {
      await client.query("ROLLBACK");
    }
    console.log(
      "   ✅ canonical column, primary key, helper trigger, and helper function are exact",
    );
    console.log(
      "   ✅ canonical SELECT/INSERT/RETURNING/UPSERT/UPDATE/DELETE/locking statements pass",
    );
    console.log(
      "   ✅ all six helper tiers and ON CONFLICT preservation remain exact\n",
    );
  } finally {
    await client.end();
  }
}
