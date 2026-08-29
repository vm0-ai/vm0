import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orgPlanEntitlementsCanonicalWrites } from "@okouai/db/operations/org-plan-entitlement-canonical-write";
import {
  orgPlanEntitlementLegacyColumns,
  orgPlanEntitlements,
} from "@okouai/db/schema/org-plan-entitlement";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  exerciseCurrentApplicationStatements,
  exercisePreviousReleaseApplicationStatements,
} from "./test-org-plan-entitlement-restriction-expansion";
import {
  ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER,
  validatePermanentOrgPlanEntitlementRestrictionState,
} from "./test-org-plan-entitlement-restriction-permanent";

export const ORG_PLAN_ENTITLEMENT_RESTRICTION_NOT_NULL_MIGRATION =
  "1026_org_plan_entitlement_restriction_not_null";

const previousMigration = "1025_curved_wither";
const temporaryConstraintName =
  "org_plan_entitlements_restricted_built_in_models_not_null_1026";
const bridgeTriggerName =
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER.triggerName;
const helperTriggerName = "ensure_legacy_org_metadata_plan_entitlement";
const testDatabaseName = "migration_org_plan_restriction_not_null_30214";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousReleaseWrites = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementLegacyColumns(),
);

interface CatalogIdentityRow {
  readonly bodyHash: string;
  readonly functionConfig: readonly string[] | null;
  readonly functionDefinition: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly languageName: string;
  readonly leakproof: boolean;
  readonly ownerName: string;
  readonly parallelSafety: string;
  readonly returnsSet: boolean;
  readonly securityDefiner: boolean;
  readonly strict: boolean;
  readonly tableName: string;
  readonly triggerDefinition: string;
  readonly triggerEnabled: string;
  readonly triggerName: string;
  readonly volatility: string;
}

interface ColumnCatalogRow {
  readonly columnDefault: string | null;
  readonly columnName: string;
  readonly formattedType: string;
  readonly hasMissing: boolean;
  readonly notNull: boolean;
}

interface RestrictionRow {
  readonly canonical: boolean | null;
  readonly ctid: string;
  readonly legacy: boolean | null;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
  readonly xmin: string;
}

interface RestrictionPair {
  readonly canonical: boolean;
  readonly legacy: boolean;
  readonly orgId: string;
}

function createDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function executeOnAdminDatabase(
  baseUrl: string,
  query: string,
): Promise<void> {
  const client = new Client({
    connectionString: createDatabaseUrl(baseUrl, "postgres"),
  });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

async function createDatabase(baseUrl: string): Promise<string> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`,
  );
  await executeOnAdminDatabase(
    baseUrl,
    `CREATE DATABASE "${testDatabaseName}"`,
  );
  return createDatabaseUrl(baseUrl, testDatabaseName);
}

async function dropDatabase(baseUrl: string): Promise<void> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`,
  );
}

async function connect(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

function splitMigrationStatements(migrationSql: string): readonly string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

function requiredStatement(
  statements: readonly string[],
  marker: string,
): string {
  const statement = statements.find((candidate) => {
    return candidate.includes(marker);
  });
  assert.ok(statement);
  return statement;
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    assert.fail(`Expected an object containing ${key}`);
  }
  assert.equal(Reflect.has(value, key), true);
  return Reflect.get(value, key);
}

function objectHasField(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) {
    assert.fail(`Expected an object when checking ${key}`);
  }
  return Reflect.has(value, key);
}

async function validateGeneratedArtifacts(): Promise<void> {
  const fullColumns = getTableConfig(orgPlanEntitlements).columns;
  const fullCanonical = fullColumns.find((column) => {
    return column.name === "restricted_built_in_models";
  });
  const fullLegacy = fullColumns.find((column) => {
    return column.name === "restricted_vm0_models";
  });
  assert.ok(fullCanonical);
  assert.ok(fullLegacy);
  assert.equal(fullCanonical.notNull, true);
  assert.equal(fullCanonical.hasDefault, false);
  assert.equal(fullCanonical.default, undefined);
  assert.equal(fullLegacy.notNull, true);
  assert.equal(fullLegacy.hasDefault, true);
  assert.equal(fullLegacy.default, true);

  const canonicalWriteColumns = getTableConfig(
    orgPlanEntitlementsCanonicalWrites,
  ).columns;
  const canonicalWriteColumn = canonicalWriteColumns.find((column) => {
    return column.name === "restricted_built_in_models";
  });
  assert.ok(canonicalWriteColumn);
  assert.equal(canonicalWriteColumn.notNull, true);
  assert.equal(canonicalWriteColumn.hasDefault, false);
  assert.equal(canonicalWriteColumn.default, undefined);
  assert.equal(
    canonicalWriteColumns.some((column) => {
      return column.name === "restricted_vm0_models";
    }),
    false,
  );

  const previousWriteColumns = getTableConfig(previousReleaseWrites).columns;
  const previousLegacyColumn = previousWriteColumns.find((column) => {
    return column.name === "restricted_vm0_models";
  });
  assert.ok(previousLegacyColumn);
  assert.equal(previousLegacyColumn.notNull, true);
  assert.equal(previousLegacyColumn.hasDefault, true);
  assert.equal(previousLegacyColumn.default, true);
  assert.equal(
    previousWriteColumns.some((column) => {
      return column.name === "restricted_built_in_models";
    }),
    false,
  );

  const snapshot = JSON.parse(
    await fs.readFile(
      path.join(
        migrationsDirectory,
        `meta/${ORG_PLAN_ENTITLEMENT_RESTRICTION_NOT_NULL_MIGRATION.replace(
          /_.*/u,
          "",
        )}_snapshot.json`,
      ),
      "utf8",
    ),
  ) as unknown;
  const tables = objectField(snapshot, "tables");
  const table = objectField(tables, "public.org_plan_entitlements");
  const columns = objectField(table, "columns");
  const canonical = objectField(columns, "restricted_built_in_models");
  const legacy = objectField(columns, "restricted_vm0_models");
  assert.equal(objectField(canonical, "notNull"), true);
  assert.equal(objectHasField(canonical, "default"), false);
  assert.equal(objectField(legacy, "notNull"), true);
  assert.equal(objectField(legacy, "default"), true);
}

export function validateOrgPlanEntitlementRestrictionNotNullMigrationSql(
  migrationSql: string,
): readonly string[] {
  const statements = splitMigrationStatements(migrationSql);
  assert.equal(statements.length, 10);
  assert.match(statements[0] ?? "", /SET LOCAL lock_timeout = '1s';$/u);
  assert.equal(statements[1], "SET LOCAL statement_timeout = '10s';");

  const preflight = requiredStatement(
    statements,
    "requires the accepted column shape",
  );
  const reconciliation = requiredStatement(
    statements,
    'UPDATE "org_plan_entitlements"',
  );
  const postflight = requiredStatement(
    statements,
    "reconciliation left canonical NULL rows",
  );
  const addConstraint = requiredStatement(
    statements,
    `ADD CONSTRAINT "${temporaryConstraintName}"`,
  );
  const validateConstraint = requiredStatement(
    statements,
    `VALIDATE CONSTRAINT "${temporaryConstraintName}"`,
  );
  const setNotNull = requiredStatement(
    statements,
    'ALTER COLUMN "restricted_built_in_models" SET NOT NULL',
  );
  const dropConstraint = requiredStatement(
    statements,
    `DROP CONSTRAINT "${temporaryConstraintName}"`,
  );
  const finalCatalog = requiredStatement(
    statements,
    "produced an unexpected final column shape",
  );

  assert.ok(statements.indexOf(preflight) < statements.indexOf(reconciliation));
  assert.ok(
    statements.indexOf(reconciliation) < statements.indexOf(postflight),
  );
  assert.ok(statements.indexOf(postflight) < statements.indexOf(addConstraint));
  assert.ok(
    statements.indexOf(addConstraint) < statements.indexOf(validateConstraint),
  );
  assert.ok(
    statements.indexOf(validateConstraint) < statements.indexOf(setNotNull),
  );
  assert.ok(
    statements.indexOf(setNotNull) < statements.indexOf(dropConstraint),
  );
  assert.ok(
    statements.indexOf(dropConstraint) < statements.indexOf(finalCatalog),
  );

  for (const expected of [
    "found legacy NULL canonical-only rows",
    "found legacy NULL null/null rows",
    "found unequal dual rows",
    "requires the accepted column shape",
    "requires the accepted enabled 1023 bridge",
    "requires the accepted org metadata helper",
    ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER.definition,
    ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION.bodyHash,
    ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION.bodyHash,
  ]) {
    assert.ok(preflight.includes(expected));
  }
  assert.match(preflight, /"trigger_row"\."tgenabled" = 'O'/u);
  assert.match(
    preflight,
    /"attribute_row"\."attname" = 'restricted_built_in_models'[\s\S]*?NOT "attribute_row"\."attnotnull"[\s\S]*?"default_row"\."oid" IS NULL/u,
  );
  assert.match(
    preflight,
    /"attribute_row"\."attname" = 'restricted_vm0_models'[\s\S]*?"attribute_row"\."attnotnull"[\s\S]*?pg_catalog\.pg_get_expr\([\s\S]*?\) = 'true'/u,
  );
  assert.match(
    preflight,
    /"restricted_vm0_models" IS NULL\s+AND "restricted_built_in_models" IS NOT NULL/u,
  );
  assert.match(
    preflight,
    /"restricted_vm0_models" IS NULL\s+AND "restricted_built_in_models" IS NULL/u,
  );
  assert.match(
    preflight,
    /"restricted_vm0_models" IS NOT NULL\s+AND "restricted_built_in_models" IS NOT NULL\s+AND "restricted_vm0_models" IS DISTINCT FROM\s+"restricted_built_in_models"/u,
  );

  assert.match(
    reconciliation,
    /^UPDATE "org_plan_entitlements"\s+SET "restricted_built_in_models" = "restricted_vm0_models"\s+WHERE "restricted_built_in_models" IS NULL\s+AND "restricted_vm0_models" IS NOT NULL;$/u,
  );
  for (const expected of [
    "left legacy NULL rows",
    "left canonical NULL rows",
    "left unequal dual rows",
  ]) {
    assert.ok(postflight.includes(expected));
  }
  assert.match(
    addConstraint,
    /CHECK \("restricted_built_in_models" IS NOT NULL\) NOT VALID;$/u,
  );
  assert.match(
    finalCatalog,
    /"attribute_row"\."attname" = 'restricted_built_in_models'[\s\S]*?"attribute_row"\."attnotnull"[\s\S]*?"default_row"\."oid" IS NULL/u,
  );
  assert.match(
    finalCatalog,
    /"attribute_row"\."attname" = 'restricted_vm0_models'[\s\S]*?"attribute_row"\."attnotnull"[\s\S]*?pg_catalog\.pg_get_expr\([\s\S]*?\) = 'true'/u,
  );
  assert.ok(finalCatalog.includes("left the temporary constraint installed"));

  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.equal(
    countOccurrences(executableSql, 'UPDATE "org_plan_entitlements"'),
    1,
  );
  assert.doesNotMatch(migrationSql, /-- vm0:non-transactional/u);
  assert.doesNotMatch(executableSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(
    executableSql,
    /ALTER\s+TABLE\s+"org_plan_entitlements"\s+ALTER\s+COLUMN\s+"restricted_vm0_models"/iu,
  );
  assert.doesNotMatch(
    executableSql,
    /ALTER\s+TABLE\s+"org_plan_entitlements"\s+ALTER\s+COLUMN\s+"restricted_built_in_models"\s+(?:SET|DROP)\s+DEFAULT/iu,
  );
  for (const statement of statements) {
    const executableStatement = statement.replace(
      /^(?:--[^\n]*(?:\n|$)\s*)+/u,
      "",
    );
    assert.doesNotMatch(
      executableStatement,
      /^(?:CREATE|ALTER|DROP)\s+(?:TRIGGER|FUNCTION)\s+"?(?:sync_org_plan_entitlement_model_restrictions_1023|ensure_legacy_org_metadata_plan_entitlement)/iu,
    );
  }
  return statements;
}

async function readRestrictionRows(
  client: Client,
  orgIds: readonly string[],
): Promise<readonly RestrictionRow[]> {
  const result = await client.query<RestrictionRow>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."restricted_vm0_models" AS "legacy",
        "row"."restricted_built_in_models" AS "canonical",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        to_jsonb("row") - 'restricted_vm0_models'
          - 'restricted_built_in_models' AS "rest"
      FROM "org_plan_entitlements" AS "row"
      WHERE "row"."org_id" = ANY($1::text[])
      ORDER BY "row"."org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

async function readRestrictionPairs(
  client: Client,
  orgIds: readonly string[],
): Promise<readonly RestrictionPair[]> {
  const result = await client.query<RestrictionPair>(
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

async function readColumnCatalog(
  client: Client,
): Promise<readonly ColumnCatalogRow[]> {
  const result = await client.query<ColumnCatalogRow>(`
    SELECT
      "attribute_row"."attname" AS "columnName",
      "attribute_row"."attnotnull" AS "notNull",
      "attribute_row"."atthasmissing" AS "hasMissing",
      pg_catalog.format_type(
        "attribute_row"."atttypid", "attribute_row"."atttypmod"
      ) AS "formattedType",
      pg_catalog.pg_get_expr(
        "default_row"."adbin", "default_row"."adrelid"
      ) AS "columnDefault"
    FROM "pg_catalog"."pg_attribute" AS "attribute_row"
    LEFT JOIN "pg_catalog"."pg_attrdef" AS "default_row"
      ON "default_row"."adrelid" = "attribute_row"."attrelid"
      AND "default_row"."adnum" = "attribute_row"."attnum"
    WHERE "attribute_row"."attrelid" =
        'public.org_plan_entitlements'::regclass
      AND "attribute_row"."attname" IN (
        'restricted_vm0_models',
        'restricted_built_in_models'
      )
      AND NOT "attribute_row"."attisdropped"
    ORDER BY "attribute_row"."attname"
  `);
  return result.rows;
}

async function readCatalogIdentity(
  client: Client,
): Promise<readonly CatalogIdentityRow[]> {
  const result = await client.query<CatalogIdentityRow>(`
    SELECT
      "table_row"."relname" AS "tableName",
      "trigger_row"."tgname" AS "triggerName",
      "trigger_row"."tgenabled"::text AS "triggerEnabled",
      pg_catalog.pg_get_triggerdef("trigger_row"."oid")
        AS "triggerDefinition",
      "function_row"."proname" AS "functionName",
      pg_catalog.pg_get_function_identity_arguments("function_row"."oid")
        AS "identityArguments",
      pg_catalog.md5("function_row"."prosrc") AS "bodyHash",
      pg_catalog.pg_get_functiondef("function_row"."oid")
        AS "functionDefinition",
      pg_catalog.pg_get_userbyid("function_row"."proowner") AS "ownerName",
      "language_row"."lanname" AS "languageName",
      "function_row"."prosecdef" AS "securityDefiner",
      "function_row"."proleakproof" AS "leakproof",
      "function_row"."proisstrict" AS "strict",
      "function_row"."proretset" AS "returnsSet",
      "function_row"."provolatile"::text AS "volatility",
      "function_row"."proparallel"::text AS "parallelSafety",
      "function_row"."proconfig" AS "functionConfig"
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
      ON "function_row"."oid" = "trigger_row"."tgfoid"
    INNER JOIN "pg_catalog"."pg_language" AS "language_row"
      ON "language_row"."oid" = "function_row"."prolang"
    WHERE NOT "trigger_row"."tgisinternal"
      AND "trigger_row"."tgname" IN (
        'ensure_legacy_org_metadata_plan_entitlement',
        'sync_org_plan_entitlement_model_restrictions_1023'
      )
    ORDER BY "trigger_row"."tgname"
  `);
  assert.equal(result.rows.length, 2);
  return result.rows;
}

async function temporaryConstraintCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT count(*)::integer AS "count"
      FROM "pg_catalog"."pg_constraint" AS "constraint_row"
      WHERE "constraint_row"."conrelid" =
          'public.org_plan_entitlements'::regclass
        AND "constraint_row"."conname" = $1
    `,
    [temporaryConstraintName],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function applyStatementsInTransaction(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function expectMigrationFailure(
  client: Client,
  statements: readonly string[],
  expected: RegExp,
): Promise<unknown> {
  let migrationError: unknown;
  try {
    await applyStatementsInTransaction(client, statements);
  } catch (error) {
    migrationError = error;
  }
  assert.match(errorMessage(migrationError), expected);
  return migrationError;
}

async function seedWithBridgeDisabled(
  client: Client,
  orgId: string,
  legacy: boolean | null,
  canonical: boolean | null,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" DISABLE TRIGGER "${bridgeTriggerName}"`,
    );
    await client.query(
      `
        INSERT INTO "org_plan_entitlements" (
          "org_id", "plan_key", "plan_rank", "source",
          "restricted_vm0_models", "restricted_built_in_models"
        ) VALUES ($1, 'fixture', 0, 'test_fixture', $2, $3)
      `,
      [orgId, legacy, canonical],
    );
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "${bridgeTriggerName}"`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assertRowUnchanged(
  client: Client,
  orgId: string,
  expected: readonly RestrictionRow[],
): Promise<void> {
  assert.deepEqual(await readRestrictionRows(client, [orgId]), expected);
}

async function validateFailClosedPreflight(
  client: Client,
  statements: readonly string[],
  targetOrgId: string,
): Promise<void> {
  const targetBefore = await readRestrictionRows(client, [targetOrgId]);
  assert.equal(targetBefore[0]?.canonical, null);

  await client.query(
    `ALTER TABLE "org_plan_entitlements" DISABLE TRIGGER "${bridgeTriggerName}"`,
  );
  try {
    await expectMigrationFailure(
      client,
      statements,
      /requires the accepted enabled 1023 bridge/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "${bridgeTriggerName}"`,
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);

  await client.query(
    `ALTER TABLE "org_metadata" DISABLE TRIGGER "${helperTriggerName}"`,
  );
  try {
    await expectMigrationFailure(
      client,
      statements,
      /requires the accepted org metadata helper/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_metadata" ENABLE TRIGGER "${helperTriggerName}"`,
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);

  await client.query(
    `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_built_in_models" SET DEFAULT false`,
  );
  try {
    await expectMigrationFailure(
      client,
      statements,
      /requires the accepted column shape/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_built_in_models" DROP DEFAULT`,
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);

  await client.query(
    `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" DROP DEFAULT`,
  );
  try {
    await expectMigrationFailure(
      client,
      statements,
      /requires the accepted column shape/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" SET DEFAULT true`,
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);

  const unequalOrgId = "org-plan-restriction-30214-preflight-unequal";
  await seedWithBridgeDisabled(client, unequalOrgId, false, true);
  try {
    await expectMigrationFailure(
      client,
      statements,
      /found unequal dual rows/u,
    );
  } finally {
    await client.query(
      `DELETE FROM "org_plan_entitlements" WHERE "org_id" = $1`,
      [unequalOrgId],
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);

  const canonicalOnlyOrgId =
    "org-plan-restriction-30214-preflight-canonical-only";
  await client.query(
    `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" DROP NOT NULL`,
  );
  try {
    await seedWithBridgeDisabled(client, canonicalOnlyOrgId, null, true);
    await expectMigrationFailure(
      client,
      statements,
      /found legacy NULL canonical-only rows/u,
    );
  } finally {
    await client.query(
      `DELETE FROM "org_plan_entitlements" WHERE "org_id" = $1`,
      [canonicalOnlyOrgId],
    );
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" SET NOT NULL`,
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);

  const nullPairOrgId = "org-plan-restriction-30214-preflight-null-pair";
  await client.query(
    `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" DROP NOT NULL`,
  );
  try {
    await seedWithBridgeDisabled(client, nullPairOrgId, null, null);
    await expectMigrationFailure(
      client,
      statements,
      /found legacy NULL null\/null rows/u,
    );
  } finally {
    await client.query(
      `DELETE FROM "org_plan_entitlements" WHERE "org_id" = $1`,
      [nullPairOrgId],
    );
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" SET NOT NULL`,
    );
  }
  await assertRowUnchanged(client, targetOrgId, targetBefore);
  assert.equal(await temporaryConstraintCount(client), 0);
}

async function validateBoundedLockFailure(
  databaseUrl: string,
  statements: readonly string[],
  targetOrgId: string,
): Promise<void> {
  const locker = await connect(databaseUrl);
  const runner = await connect(databaseUrl);
  try {
    await locker.query("BEGIN");
    await locker.query(
      `SELECT 1 FROM "org_plan_entitlements" WHERE "org_id" = $1 FOR UPDATE`,
      [targetOrgId],
    );
    const migrationError = await expectMigrationFailure(
      runner,
      statements,
      /lock timeout/u,
    );
    assert.equal(databaseErrorField(migrationError, "code"), "55P03");
  } finally {
    await locker.query("ROLLBACK").catch(() => {
      return undefined;
    });
    await locker.end();
    await runner.end();
  }
}

async function exercisePreviousReleaseStatements(
  database: NodePgDatabase<Record<string, never>>,
  client: Client,
  prefix: string,
): Promise<void> {
  const falseId = `${prefix}-legacy-insert-false`;
  const trueId = `${prefix}-legacy-insert-true`;
  const upsertId = `${prefix}-legacy-upsert`;

  const falseInsert = await database
    .insert(previousReleaseWrites)
    .values({
      orgId: falseId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedVm0Models: false,
    })
    .returning({ legacy: previousReleaseWrites.restrictedVm0Models });
  assert.deepEqual(falseInsert, [{ legacy: false }]);
  const trueInsert = await database
    .insert(previousReleaseWrites)
    .values({
      orgId: trueId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedVm0Models: true,
    })
    .returning({ legacy: previousReleaseWrites.restrictedVm0Models });
  assert.deepEqual(trueInsert, [{ legacy: true }]);
  assert.deepEqual(await readRestrictionPairs(client, [falseId, trueId]), [
    { canonical: false, legacy: false, orgId: falseId },
    { canonical: true, legacy: true, orgId: trueId },
  ]);

  const falseUpdate = await database
    .update(previousReleaseWrites)
    .set({ restrictedVm0Models: false })
    .where(eq(previousReleaseWrites.orgId, trueId))
    .returning({ legacy: previousReleaseWrites.restrictedVm0Models });
  assert.deepEqual(falseUpdate, [{ legacy: false }]);
  const trueUpdate = await database
    .update(previousReleaseWrites)
    .set({ restrictedVm0Models: true })
    .where(eq(previousReleaseWrites.orgId, trueId))
    .returning({ legacy: previousReleaseWrites.restrictedVm0Models });
  assert.deepEqual(trueUpdate, [{ legacy: true }]);

  for (const restrictedVm0Models of [false, true] as const) {
    const upsert = await database
      .insert(previousReleaseWrites)
      .values({
        orgId: upsertId,
        planKey: "fixture",
        planRank: 0,
        source: "test_fixture",
        restrictedVm0Models,
      })
      .onConflictDoUpdate({
        target: previousReleaseWrites.orgId,
        set: { restrictedVm0Models },
      })
      .returning({ legacy: previousReleaseWrites.restrictedVm0Models });
    assert.deepEqual(upsert, [{ legacy: restrictedVm0Models }]);
  }
  const ignored = await database
    .insert(previousReleaseWrites)
    .values({
      orgId: upsertId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedVm0Models: false,
    })
    .onConflictDoNothing()
    .returning({ legacy: previousReleaseWrites.restrictedVm0Models });
  assert.deepEqual(ignored, []);

  await database.transaction(async (tx) => {
    const locked = await tx
      .select({ legacy: previousReleaseWrites.restrictedVm0Models })
      .from(previousReleaseWrites)
      .where(eq(previousReleaseWrites.orgId, upsertId))
      .for("update");
    assert.deepEqual(locked, [{ legacy: true }]);
  });
  assert.deepEqual(await readRestrictionPairs(client, [upsertId]), [
    { canonical: true, legacy: true, orgId: upsertId },
  ]);

  const deleted = await database
    .delete(previousReleaseWrites)
    .where(eq(previousReleaseWrites.orgId, falseId))
    .returning({ orgId: previousReleaseWrites.orgId });
  assert.deepEqual(deleted, [{ orgId: falseId }]);
}

async function exerciseCurrentCanonicalStatements(
  database: NodePgDatabase<Record<string, never>>,
  client: Client,
  prefix: string,
): Promise<void> {
  const falseId = `${prefix}-canonical-insert-false`;
  const trueId = `${prefix}-canonical-insert-true`;
  const upsertId = `${prefix}-canonical-upsert`;

  const falseInsert = await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId: falseId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: false,
    })
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(falseInsert, [{ canonical: false }]);
  const trueInsert = await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId: trueId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: true,
    })
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(trueInsert, [{ canonical: true }]);
  assert.deepEqual(await readRestrictionPairs(client, [falseId, trueId]), [
    { canonical: false, legacy: false, orgId: falseId },
    { canonical: true, legacy: true, orgId: trueId },
  ]);

  const falseUpdate = await database
    .update(orgPlanEntitlementsCanonicalWrites)
    .set({ restrictedBuiltInModels: false })
    .where(eq(orgPlanEntitlementsCanonicalWrites.orgId, trueId))
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(falseUpdate, [{ canonical: false }]);
  const trueUpdate = await database
    .update(orgPlanEntitlementsCanonicalWrites)
    .set({ restrictedBuiltInModels: true })
    .where(eq(orgPlanEntitlementsCanonicalWrites.orgId, trueId))
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(trueUpdate, [{ canonical: true }]);

  for (const restrictedBuiltInModels of [false, true] as const) {
    const upsert = await database
      .insert(orgPlanEntitlementsCanonicalWrites)
      .values({
        orgId: upsertId,
        planKey: "fixture",
        planRank: 0,
        source: "test_fixture",
        restrictedBuiltInModels,
      })
      .onConflictDoUpdate({
        target: orgPlanEntitlementsCanonicalWrites.orgId,
        set: { restrictedBuiltInModels },
      })
      .returning({
        canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
      });
    assert.deepEqual(upsert, [{ canonical: restrictedBuiltInModels }]);
  }
  const ignored = await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId: upsertId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: false,
    })
    .onConflictDoNothing()
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(ignored, []);

  await database.transaction(async (tx) => {
    const locked = await tx
      .select({
        canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
      })
      .from(orgPlanEntitlementsCanonicalWrites)
      .where(eq(orgPlanEntitlementsCanonicalWrites.orgId, upsertId))
      .for("update");
    assert.deepEqual(locked, [{ canonical: true }]);
  });
  assert.deepEqual(await readRestrictionPairs(client, [upsertId]), [
    { canonical: true, legacy: true, orgId: upsertId },
  ]);

  const deleted = await database
    .delete(orgPlanEntitlementsCanonicalWrites)
    .where(eq(orgPlanEntitlementsCanonicalWrites.orgId, falseId))
    .returning({ orgId: orgPlanEntitlementsCanonicalWrites.orgId });
  assert.deepEqual(deleted, [{ orgId: falseId }]);
}

async function validatePreviousAndCurrentStatements(
  client: Client,
): Promise<void> {
  const database = drizzle(client);
  await exercisePreviousReleaseStatements(
    database,
    client,
    "org-plan-restriction-30214",
  );
  await exerciseCurrentCanonicalStatements(
    database,
    client,
    "org-plan-restriction-30214",
  );
  await exercisePreviousReleaseApplicationStatements(
    database,
    "org-plan-restriction-30214-rollback-client",
  );
  await exerciseCurrentApplicationStatements(
    database,
    "org-plan-restriction-30214-current-client",
  );
}

export async function validateOrgPlanEntitlementRestrictionNotNull(
  baseDbUrl: string,
): Promise<void> {
  console.log(
    "=== Validate org plan entitlement restriction NOT NULL promotion ===\n",
  );
  await validateGeneratedArtifacts();
  const migrationSql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${ORG_PLAN_ENTITLEMENT_RESTRICTION_NOT_NULL_MIGRATION}.sql`,
    ),
    "utf8",
  );
  const statements =
    validateOrgPlanEntitlementRestrictionNotNullMigrationSql(migrationSql);
  const reconciliation = requiredStatement(
    statements,
    'UPDATE "org_plan_entitlements"',
  );

  const databaseUrl = await createDatabase(baseDbUrl);
  try {
    const client = await connect(databaseUrl);
    try {
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        previousMigration,
      );
      const targetOrgId = "org-plan-restriction-30214-reconcile-false";
      const equalFalseOrgId = "org-plan-restriction-30214-equal-false";
      const equalTrueOrgId = "org-plan-restriction-30214-equal-true";
      await seedWithBridgeDisabled(client, targetOrgId, false, null);
      await client.query(
        `
          INSERT INTO "org_plan_entitlements" (
            "org_id", "plan_key", "plan_rank", "source",
            "restricted_built_in_models"
          ) VALUES
            ($1, 'fixture', 0, 'test_fixture', false),
            ($2, 'fixture', 0, 'test_fixture', true)
        `,
        [equalFalseOrgId, equalTrueOrgId],
      );
      const proofOrgIds = [targetOrgId, equalFalseOrgId, equalTrueOrgId].sort();
      const before = await readRestrictionRows(client, proofOrgIds);
      const catalogBefore = await readCatalogIdentity(client);
      assert.deepEqual(await readColumnCatalog(client), [
        {
          columnDefault: null,
          columnName: "restricted_built_in_models",
          formattedType: "boolean",
          hasMissing: false,
          notNull: false,
        },
        {
          columnDefault: "true",
          columnName: "restricted_vm0_models",
          formattedType: "boolean",
          hasMissing: false,
          notNull: true,
        },
      ]);

      await validateFailClosedPreflight(client, statements, targetOrgId);
      await validateBoundedLockFailure(databaseUrl, statements, targetOrgId);
      assert.deepEqual(await readRestrictionRows(client, proofOrgIds), before);
      assert.equal(await temporaryConstraintCount(client), 0);

      await applyStatementsInTransaction(client, statements);
      const after = await readRestrictionRows(client, proofOrgIds);
      assert.deepEqual(
        after.map((row) => {
          return {
            canonical: row.canonical,
            legacy: row.legacy,
            orgId: row.orgId,
            rest: row.rest,
          };
        }),
        before.map((row) => {
          return {
            canonical: row.legacy,
            legacy: row.legacy,
            orgId: row.orgId,
            rest: row.rest,
          };
        }),
      );
      for (const equalOrgId of [equalFalseOrgId, equalTrueOrgId]) {
        const equalBefore = before.find((row) => {
          return row.orgId === equalOrgId;
        });
        const equalAfter = after.find((row) => {
          return row.orgId === equalOrgId;
        });
        assert.ok(equalBefore);
        assert.ok(equalAfter);
        assert.equal(equalAfter.ctid, equalBefore.ctid);
        assert.equal(equalAfter.xmin, equalBefore.xmin);
      }
      assert.deepEqual(await readCatalogIdentity(client), catalogBefore);
      assert.deepEqual(await readColumnCatalog(client), [
        {
          columnDefault: null,
          columnName: "restricted_built_in_models",
          formattedType: "boolean",
          hasMissing: false,
          notNull: true,
        },
        {
          columnDefault: "true",
          columnName: "restricted_vm0_models",
          formattedType: "boolean",
          hasMissing: false,
          notNull: true,
        },
      ]);
      assert.equal(await temporaryConstraintCount(client), 0);

      const beforeReconciliationRerun = await readRestrictionRows(
        client,
        proofOrgIds,
      );
      await applyStatementsInTransaction(client, [reconciliation]);
      assert.deepEqual(
        await readRestrictionRows(client, proofOrgIds),
        beforeReconciliationRerun,
      );

      await validatePreviousAndCurrentStatements(client);
    } finally {
      await client.end();
    }

    await validatePermanentOrgPlanEntitlementRestrictionState(databaseUrl);
    console.log("   ✅ fail-closed preflight precedes the only data mutation");
    console.log("   ✅ reconciliation is predicate-bounded and idempotent");
    console.log("   ✅ staged validation promotes NOT NULL without a default");
    console.log("   ✅ old and current statement shapes remain compatible\n");
  } finally {
    await dropDatabase(baseDbUrl);
  }
}
