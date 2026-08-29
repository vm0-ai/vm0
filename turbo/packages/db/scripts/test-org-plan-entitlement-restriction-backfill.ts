import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION,
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER,
  validatePermanentOrgPlanEntitlementRestrictionState,
} from "./test-org-plan-entitlement-restriction-permanent";

export const ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_MIGRATION =
  "1024_org_plan_entitlement_restriction_backfill";
export const ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE =
  "backfill_org_plan_entitlement_restrictions_1024";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const testDatabaseName = "migration_org_plan_restriction_backfill_30193";
const bridgeTriggerName =
  ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER.triggerName;
const helperTriggerName = "ensure_legacy_org_metadata_plan_entitlement";

interface SeedRow {
  readonly legacy: boolean;
  readonly orgId: string;
}

interface RestrictionSnapshot {
  readonly canonical: boolean | null;
  readonly ctid: string;
  readonly legacy: boolean;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
  readonly xmin: string;
}

interface RestrictionCatalogRow {
  readonly bodyHash: string;
  readonly functionDefinition: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly languageName: string;
  readonly ownerName: string;
  readonly parallelSafety: string;
  readonly securityDefiner: boolean;
  readonly strict: boolean;
  readonly triggerDefinition: string;
  readonly triggerEnabled: string;
  readonly triggerName: string;
  readonly volatility: string;
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

function backfillProcedureStatement(statements: readonly string[]): string {
  return requiredStatement(
    statements,
    `CREATE OR REPLACE PROCEDURE "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(`,
  );
}

function validateBackfillPreflight(
  statements: readonly string[],
  procedure: string,
): void {
  const preflight = requiredStatement(
    statements,
    "requires the accepted column shape",
  );
  assert.ok(
    statements.indexOf(preflight) < statements.indexOf(procedure),
    "the fail-closed preflight must run before the backfill procedure",
  );
  for (const expected of [
    "requires the accepted column shape",
    "requires the accepted enabled 1023 bridge",
    "requires the accepted org metadata helper",
    "found canonical-only rows",
    "found unequal dual rows",
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
    /"restricted_built_in_models" IS NOT NULL\s+AND "restricted_vm0_models" IS DISTINCT FROM\s+"restricted_built_in_models"/u,
  );
}

function validateBackfillProcedure(
  statements: readonly string[],
  procedure: string,
): void {
  assert.match(procedure, /v_scan_after text := NULL/u);
  assert.match(
    procedure,
    /WHERE \(v_scan_after IS NULL OR "candidate"\."org_id" > v_scan_after\)\s+AND "candidate"\."restricted_built_in_models" IS NULL\s+AND "candidate"\."restricted_vm0_models" IS NOT NULL/u,
  );
  assert.match(
    procedure,
    /ORDER BY "candidate"\."org_id"\s+LIMIT 500\s+FOR UPDATE OF "candidate" SKIP LOCKED/u,
  );
  assert.match(
    procedure,
    /UPDATE "org_plan_entitlements" AS "target"\s+SET "restricted_built_in_models" =\s+"batch"\."restricted_vm0_models"\s+FROM "batch"/u,
  );
  assert.match(
    procedure,
    /WHERE "target"\."org_id" = "batch"\."org_id"\s+AND "target"\."restricted_built_in_models" IS NULL\s+AND "target"\."restricted_vm0_models" IS NOT NULL\s+AND "target"\."restricted_vm0_models" =\s+"batch"\."restricted_vm0_models"/u,
  );
  assert.equal(
    countOccurrences(procedure, 'UPDATE "org_plan_entitlements" AS "target"'),
    1,
  );
  assert.equal((procedure.match(/\bCOMMIT;/gu) ?? []).length, 1);
  assert.match(
    procedure,
    /COMMIT;\s+SET LOCAL lock_timeout = '1s';\s+SET LOCAL transaction_timeout = '5min';/u,
  );
  assert.doesNotMatch(procedure, /statement_timeout/u);
  assert.equal(countOccurrences(procedure, "PERFORM pg_sleep(0.05);"), 2);
  assert.match(procedure, /p_no_progress_timeout > interval '30 seconds'/u);
  assert.match(
    procedure,
    /v_updated_ids IS DISTINCT FROM v_batch_ids[\s\S]*?v_updated_legacy_values IS DISTINCT FROM v_batch_legacy_values[\s\S]*?v_updated_canonical_values IS DISTINCT FROM v_batch_legacy_values/u,
  );
  assert.ok(
    procedure.includes("did not preserve initial row identities and count"),
  );
  assert.ok(procedure.includes("did not preserve initial legacy values"));
  assert.ok(
    procedure.includes("made no progress for % while eligible rows remained"),
  );
  assert.equal(
    statements.includes(
      `CALL "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(interval '30 seconds');`,
    ),
    true,
  );
  assert.equal(
    statements.includes(
      `DROP PROCEDURE IF EXISTS "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(interval);`,
    ),
    true,
  );
}

function validateBackfillFinalAssertions(statements: readonly string[]): void {
  const postflight = requiredStatement(
    statements,
    "backfill procedure still exists",
  );
  for (const expected of [
    "left canonical NULL rows",
    "left canonical-only rows",
    "left unequal dual rows",
    "did not preserve the accepted enabled 1023 bridge",
    "did not preserve the accepted org metadata helper",
    "backfill procedure still exists",
    ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_TRIGGER.definition,
    ORG_PLAN_ENTITLEMENT_RESTRICTION_PERMANENT_FUNCTION.bodyHash,
    ORG_METADATA_PLAN_ENTITLEMENT_PERMANENT_FUNCTION.bodyHash,
  ]) {
    assert.ok(postflight.includes(expected));
  }
  assert.match(postflight, /to_regprocedure\(/u);
}

function validateBackfillMutationSurface(
  migrationSql: string,
  statements: readonly string[],
): void {
  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.doesNotMatch(executableSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(
    executableSql,
    /ALTER\s+TABLE\s+(?:public\.)?"?org_plan_entitlements"?/iu,
  );
  assert.doesNotMatch(
    executableSql,
    /\b(?:INSERT INTO|DELETE FROM|TRUNCATE)\s+(?:public\.)?"?org_plan_entitlements"?/iu,
  );
  assert.equal(
    countOccurrences(
      executableSql,
      'UPDATE "org_plan_entitlements" AS "target"',
    ),
    1,
  );
  for (const statement of statements) {
    const executableStatement = statement.replace(
      /^(?:--[^\n]*(?:\n|$)\s*)+/u,
      "",
    );
    assert.doesNotMatch(
      executableStatement,
      /^(?:ALTER\s+TABLE[\s\S]*?(?:DISABLE|ENABLE)\s+TRIGGER|(?:CREATE|REPLACE|DROP)\s+(?:TRIGGER|FUNCTION)\s+"?(?:sync_org_plan_entitlement_model_restrictions_1023|ensure_legacy_org_metadata_plan_entitlement))/iu,
    );
  }
  assert.doesNotMatch(executableSql, /\b620[12]\b/u);
}

export function validateOrgPlanEntitlementRestrictionBackfillMigrationSql(
  migrationSql: string,
): readonly string[] {
  const statements = splitMigrationStatements(migrationSql);
  assert.equal(statements.length, 13);
  assert.match(statements[0] ?? "", /^-- vm0:non-transactional/mu);
  const procedure = backfillProcedureStatement(statements);
  validateBackfillPreflight(statements, procedure);
  validateBackfillProcedure(statements, procedure);
  validateBackfillFinalAssertions(statements);
  validateBackfillMutationSurface(migrationSql, statements);
  return statements;
}

async function applyStatements(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await client.query(statement);
  }
}

async function readRestrictionRows(
  client: Client,
  orgIds: readonly string[],
): Promise<readonly RestrictionSnapshot[]> {
  const result = await client.query<RestrictionSnapshot>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."restricted_vm0_models" AS "legacy",
        "row"."restricted_built_in_models" AS "canonical",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        to_jsonb("row") - 'restricted_built_in_models' AS "rest"
      FROM "org_plan_entitlements" AS "row"
      WHERE "row"."org_id" = ANY($1::text[])
      ORDER BY "row"."org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

function logicalSnapshot(row: RestrictionSnapshot): {
  readonly legacy: boolean;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
} {
  return { legacy: row.legacy, orgId: row.orgId, rest: row.rest };
}

async function entitlementRowCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM "org_plan_entitlements"`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function readCatalogIdentity(
  client: Client,
): Promise<readonly RestrictionCatalogRow[]> {
  const result = await client.query<RestrictionCatalogRow>(`
    SELECT
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
      "function_row"."proisstrict" AS "strict",
      "function_row"."provolatile"::text AS "volatility",
      "function_row"."proparallel"::text AS "parallelSafety"
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
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

async function backfillProcedureCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT count(*)::integer AS "count"
      FROM "pg_catalog"."pg_proc" AS "function_row"
      WHERE "function_row"."pronamespace" = 'public'::regnamespace
        AND "function_row"."proname" = $1
        AND pg_catalog.pg_get_function_identity_arguments(
          "function_row"."oid"
        ) = 'p_no_progress_timeout interval'
    `,
    [ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function seedLegacyOnlyRows(
  client: Client,
  rows: readonly SeedRow[],
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
        )
        SELECT
          "fixture_row"."org_id", 'fixture', 0, 'test_fixture',
          "fixture_row"."legacy", NULL
        FROM unnest($1::text[], $2::boolean[])
          AS "fixture_row"("org_id", "legacy")
      `,
      [
        rows.map((row) => {
          return row.orgId;
        }),
        rows.map((row) => {
          return row.legacy;
        }),
      ],
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

async function eligibleRowCount(
  client: Client,
  orgIds: readonly string[],
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT count(*)::integer AS "count"
      FROM "org_plan_entitlements"
      WHERE "org_id" = ANY($1::text[])
        AND "restricted_built_in_models" IS NULL
    `,
    [[...orgIds]],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function waitForEligibleRowCount(
  client: Client,
  orgIds: readonly string[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await eligibleRowCount(client, orgIds)) === expectedCount) return;
    await client.query(`SELECT pg_sleep(0.01)`);
  }
  assert.equal(await eligibleRowCount(client, orgIds), expectedCount);
}

async function connect(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function lockEntitlement(client: Client, orgId: string): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `SELECT 1 FROM "org_plan_entitlements" WHERE "org_id" = $1 FOR UPDATE`,
    [orgId],
  );
}

async function validateLockRetry(
  databaseUrl: string,
  setup: Client,
): Promise<void> {
  const rows = Array.from({ length: 3 }, (_, index) => {
    return {
      legacy: index % 2 === 0,
      orgId: `org-plan-restriction-30193-lock-retry-${String(index).padStart(4, "0")}`,
    };
  });
  const orgIds = rows.map((row) => {
    return row.orgId;
  });
  await seedLegacyOnlyRows(setup, rows);
  const locker = await connect(databaseUrl);
  const runner = await connect(databaseUrl);
  const concurrentOrgId = "org-plan-restriction-30193-lock-retry-concurrent";
  try {
    await lockEntitlement(locker, orgIds[0]!);
    const running = runner.query(
      `CALL "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(interval '5 seconds')`,
    );
    await waitForEligibleRowCount(setup, orgIds, 1);

    await setup.query(
      `
        INSERT INTO "org_plan_entitlements" (
          "org_id", "plan_key", "plan_rank", "source",
          "restricted_vm0_models"
        ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
      `,
      [concurrentOrgId],
    );
    await setup.query(
      `
        UPDATE "org_plan_entitlements"
        SET "restricted_vm0_models" = true
        WHERE "org_id" = $1
      `,
      [concurrentOrgId],
    );
    await setup.query(
      `
        UPDATE "org_plan_entitlements"
        SET "restricted_built_in_models" = false
        WHERE "org_id" = $1
      `,
      [concurrentOrgId],
    );

    await locker.query("COMMIT");
    await running;
    assert.equal(await eligibleRowCount(setup, orgIds), 0);
    const concurrentRows = await readRestrictionRows(setup, [concurrentOrgId]);
    assert.equal(concurrentRows.length, 1);
    assert.deepEqual(
      {
        canonical: concurrentRows[0]?.canonical,
        legacy: concurrentRows[0]?.legacy,
        orgId: concurrentRows[0]?.orgId,
      },
      { canonical: false, legacy: false, orgId: concurrentOrgId },
    );
  } finally {
    await locker.query("ROLLBACK").catch(() => {
      return undefined;
    });
    await locker.end();
    await runner.end();
    await setup.query(
      `DELETE FROM "org_plan_entitlements" WHERE "org_id" = ANY($1::text[])`,
      [[...orgIds, concurrentOrgId]],
    );
  }
}

async function validateLockTimeout(
  databaseUrl: string,
  setup: Client,
): Promise<void> {
  const rows = Array.from({ length: 502 }, (_, index) => {
    return {
      legacy: index % 2 === 0,
      orgId: `org-plan-restriction-30193-lock-timeout-${String(index).padStart(4, "0")}`,
    };
  });
  const orgIds = rows.map((row) => {
    return row.orgId;
  });
  await seedLegacyOnlyRows(setup, rows);
  const locker = await connect(databaseUrl);
  const runner = await connect(databaseUrl);
  try {
    await lockEntitlement(locker, orgIds[0]!);
    await assert.rejects(
      runner.query(
        `CALL "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(interval '250 milliseconds')`,
      ),
      /made no progress for 00:00:00.25 while eligible rows remained/u,
    );
    assert.equal(await eligibleRowCount(setup, orgIds), 1);
    const committedBatches = await setup.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "org_plan_entitlements"
        WHERE "org_id" = ANY($1::text[])
          AND "restricted_built_in_models" IS NOT NULL
        GROUP BY "xmin"::text
        ORDER BY "count"
      `,
      [[...orgIds]],
    );
    assert.deepEqual(committedBatches.rows, [{ count: 1 }, { count: 500 }]);

    await locker.query("COMMIT");
    await runner.query(
      `CALL "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(interval '30 seconds')`,
    );
    assert.equal(await eligibleRowCount(setup, orgIds), 0);
  } finally {
    await locker.query("ROLLBACK").catch(() => {
      return undefined;
    });
    await locker.end();
    await runner.end();
    await setup.query(
      `DELETE FROM "org_plan_entitlements" WHERE "org_id" = ANY($1::text[])`,
      [[...orgIds]],
    );
  }
}

async function validateLockRetryAndTimeout(
  databaseUrl: string,
  procedure: string,
): Promise<void> {
  const setup = await connect(databaseUrl);
  await setup.query(procedure);
  try {
    await validateLockRetry(databaseUrl, setup);
    await validateLockTimeout(databaseUrl, setup);
  } finally {
    await setup.query(
      `DROP PROCEDURE IF EXISTS "${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_PROCEDURE}"(interval)`,
    );
    assert.equal(await backfillProcedureCount(setup), 0);
    await setup.end();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function expectPreflightFailure(
  client: Client,
  preflightStatements: readonly string[],
  expected: RegExp,
): Promise<void> {
  let preflightError: unknown;
  try {
    await applyStatements(client, preflightStatements);
  } catch (error) {
    preflightError = error;
  }
  await client.query("ROLLBACK");
  assert.match(errorMessage(preflightError), expected);
}

async function validateCatalogPreflightFailures(
  client: Client,
  preflightStatements: readonly string[],
): Promise<void> {
  await client.query(
    `ALTER TABLE "org_plan_entitlements" DISABLE TRIGGER "${bridgeTriggerName}"`,
  );
  try {
    await expectPreflightFailure(
      client,
      preflightStatements,
      /requires the accepted enabled 1023 bridge/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "${bridgeTriggerName}"`,
    );
  }

  await client.query(
    `ALTER TABLE "org_metadata" DISABLE TRIGGER "${helperTriggerName}"`,
  );
  try {
    await expectPreflightFailure(
      client,
      preflightStatements,
      /requires the accepted org metadata helper/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_metadata" ENABLE TRIGGER "${helperTriggerName}"`,
    );
  }
}

async function validateCanonicalOnlyPreflightFailure(
  client: Client,
  preflightStatements: readonly string[],
): Promise<void> {
  const canonicalOnlyOrgId =
    "org-plan-restriction-30193-preflight-canonical-only";
  await client.query(
    `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_vm0_models" DROP NOT NULL`,
  );
  try {
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
          ) VALUES ($1, 'fixture', 0, 'test_fixture', NULL, true)
        `,
        [canonicalOnlyOrgId],
      );
      await client.query(
        `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "${bridgeTriggerName}"`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await expectPreflightFailure(
      client,
      preflightStatements,
      /found canonical-only rows/u,
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
}

async function validateColumnShapePreflightFailure(
  client: Client,
  preflightStatements: readonly string[],
): Promise<void> {
  await client.query(
    `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_built_in_models" SET DEFAULT false`,
  );
  try {
    await expectPreflightFailure(
      client,
      preflightStatements,
      /requires the accepted column shape/u,
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ALTER COLUMN "restricted_built_in_models" DROP DEFAULT`,
    );
  }
}

async function validateUnequalPreflightFailure(
  client: Client,
  preflightStatements: readonly string[],
): Promise<void> {
  const unequalOrgId = "org-plan-restriction-30193-preflight-unequal";
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
        ) VALUES ($1, 'fixture', 0, 'test_fixture', false, true)
      `,
      [unequalOrgId],
    );
    await client.query(
      `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "${bridgeTriggerName}"`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await expectPreflightFailure(
    client,
    preflightStatements,
    /found unequal dual rows/u,
  );
  await client.query(
    `DELETE FROM "org_plan_entitlements" WHERE "org_id" = $1`,
    [unequalOrgId],
  );
}

async function validateFailClosedPreflight(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  const procedure = backfillProcedureStatement(statements);
  const preflightStatements = statements.slice(
    0,
    statements.indexOf(procedure),
  );
  const targetOrgId = "org-plan-restriction-30193-preflight-target";
  await seedLegacyOnlyRows(client, [{ legacy: false, orgId: targetOrgId }]);
  try {
    await validateCatalogPreflightFailures(client, preflightStatements);
    assert.equal(await eligibleRowCount(client, [targetOrgId]), 1);
    await validateCanonicalOnlyPreflightFailure(client, preflightStatements);
    assert.equal(await eligibleRowCount(client, [targetOrgId]), 1);
    await validateColumnShapePreflightFailure(client, preflightStatements);
    assert.equal(await eligibleRowCount(client, [targetOrgId]), 1);
    await validateUnequalPreflightFailure(client, preflightStatements);
    assert.equal(await eligibleRowCount(client, [targetOrgId]), 1);
  } finally {
    await client.query(
      `DELETE FROM "org_plan_entitlements" WHERE "org_id" = $1`,
      [targetOrgId],
    );
  }
}

async function seedBackfillProofRows(
  client: Client,
  prefix: string,
): Promise<readonly string[]> {
  const falseOrgId = `${prefix}-01-false`;
  const trueOrgId = `${prefix}-02-true`;
  const equalOrgId = `${prefix}-03-equal`;
  await seedLegacyOnlyRows(client, [
    { legacy: false, orgId: falseOrgId },
    { legacy: true, orgId: trueOrgId },
  ]);
  await client.query(
    `
      INSERT INTO "org_plan_entitlements" (
        "org_id", "plan_key", "plan_rank", "source",
        "restricted_vm0_models", "restricted_built_in_models"
      ) VALUES ($1, 'fixture', 0, 'test_fixture', true, true)
    `,
    [equalOrgId],
  );
  return [falseOrgId, trueOrgId, equalOrgId];
}

async function validateBackfillProofRows(
  client: Client,
  orgIds: readonly string[],
  before: readonly RestrictionSnapshot[],
  beforeCount: number,
): Promise<void> {
  const after = await readRestrictionRows(client, orgIds);
  assert.deepEqual(after.map(logicalSnapshot), before.map(logicalSnapshot));
  assert.deepEqual(
    after.map((row) => {
      return row.canonical;
    }),
    [false, true, true],
  );
  assert.equal(await entitlementRowCount(client), beforeCount);

  const equalBefore = before[2];
  const equalAfter = after[2];
  assert.ok(equalBefore);
  assert.ok(equalAfter);
  assert.equal(equalAfter.ctid, equalBefore.ctid);
  assert.equal(equalAfter.xmin, equalBefore.xmin);
}

async function validateIdempotentRerun(
  client: Client,
  statements: readonly string[],
  orgIds: readonly string[],
): Promise<void> {
  const before = await readRestrictionRows(client, orgIds);
  const beforeCount = await entitlementRowCount(client);
  await applyStatements(client, statements);
  assert.deepEqual(await readRestrictionRows(client, orgIds), before);
  assert.equal(await entitlementRowCount(client), beforeCount);
  assert.equal(await backfillProcedureCount(client), 0);
}

export async function validateOrgPlanEntitlementRestrictionBackfill(
  baseDbUrl: string,
): Promise<void> {
  console.log("=== Validate org plan entitlement restriction backfill ===\n");
  const migrationSql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_MIGRATION}.sql`,
    ),
    "utf8",
  );
  const statements =
    validateOrgPlanEntitlementRestrictionBackfillMigrationSql(migrationSql);
  const procedure = backfillProcedureStatement(statements);

  const dbUrl = await createDatabase(baseDbUrl);
  try {
    const client = await connect(dbUrl);
    try {
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION,
      );
      await validateFailClosedPreflight(client, statements);
    } finally {
      await client.end();
    }

    await validateLockRetryAndTimeout(dbUrl, procedure);

    const proofClient = await connect(dbUrl);
    try {
      const orgIds = await seedBackfillProofRows(
        proofClient,
        "org-plan-restriction-30193-replay",
      );
      const before = await readRestrictionRows(proofClient, orgIds);
      const beforeCount = await entitlementRowCount(proofClient);
      const catalogBefore = await readCatalogIdentity(proofClient);

      await applyMigrationsFromDirectoryUpToTag(
        proofClient,
        migrationsDirectory,
        ORG_PLAN_ENTITLEMENT_RESTRICTION_BACKFILL_MIGRATION,
      );
      await validateBackfillProofRows(proofClient, orgIds, before, beforeCount);
      assert.deepEqual(await readCatalogIdentity(proofClient), catalogBefore);
      assert.equal(await backfillProcedureCount(proofClient), 0);
      await validateIdempotentRerun(proofClient, statements, orgIds);
    } finally {
      await proofClient.end();
    }

    await validatePermanentOrgPlanEntitlementRestrictionState(dbUrl);
    console.log("   ✅ exact schema and catalog drift fail before mutation");
    console.log("   ✅ true/false history is copied without row/value loss");
    console.log("   ✅ locked rows are skipped, revisited, or fail boundedly");
    console.log(
      "   ✅ rerun is a no-op and bridge/helper identities survive\n",
    );
  } finally {
    await dropDatabase(baseDbUrl);
  }
}

export async function validateOrgPlanEntitlementRestrictionBackfillOnRegeneratedSchema(
  dbUrl: string,
  migrationSql: string,
): Promise<void> {
  const statements =
    validateOrgPlanEntitlementRestrictionBackfillMigrationSql(migrationSql);
  const client = await connect(dbUrl);
  try {
    const orgIds = await seedBackfillProofRows(
      client,
      "org-plan-restriction-30193-regenerated",
    );
    const before = await readRestrictionRows(client, orgIds);
    const beforeCount = await entitlementRowCount(client);
    const catalogBefore = await readCatalogIdentity(client);
    await applyStatements(client, statements);
    await validateBackfillProofRows(client, orgIds, before, beforeCount);
    assert.deepEqual(await readCatalogIdentity(client), catalogBefore);
    await validateIdempotentRerun(client, statements, orgIds);
  } finally {
    await client.end();
  }
}
