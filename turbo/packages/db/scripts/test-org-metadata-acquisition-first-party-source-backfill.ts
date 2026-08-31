import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION,
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION,
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER,
  validatePermanentOrgMetadataAcquisitionFirstPartySourceState,
} from "./test-org-metadata-acquisition-first-party-source-permanent";

export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_MIGRATION =
  "1034_org_metadata_acquisition_first_party_source_backfill";
export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_PROCEDURE =
  "backfill_org_metadata_acquisition_first_party_source_1034";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const testDatabaseName =
  "migration_org_metadata_acquisition_first_party_source_backfill_30556";
const bridgeTriggerName =
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER.triggerName;
const partialFailureFunctionName =
  "fail_org_metadata_acquisition_first_party_source_backfill_30556";
const partialFailureTriggerName =
  "zz_fail_org_metadata_acquisition_first_party_source_backfill_30556";

interface AcquisitionSourceClassification {
  readonly bothNull: number;
  readonly canonicalOnly: number;
  readonly equal: number;
  readonly legacyOnly: number;
  readonly unequal: number;
}

interface AcquisitionSourceSnapshot {
  readonly canonical: string | null;
  readonly ctid: string;
  readonly legacy: string | null;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
  readonly xmin: string;
}

interface BridgeCatalogIdentity {
  readonly bodyHash: string;
  readonly functionDefinition: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly triggerDefinition: string;
  readonly triggerEnabled: string;
  readonly triggerName: string;
}

interface BackfillProofFixture {
  readonly bothNullOrgId: string;
  readonly equalOrgId: string;
  readonly failureOrgId: string;
  readonly legacyOnlyCount: number;
  readonly prefix: string;
}

function createDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function connect(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function executeOnAdminDatabase(
  baseUrl: string,
  query: string,
): Promise<void> {
  const client = await connect(createDatabaseUrl(baseUrl, "postgres"));
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
    `CREATE OR REPLACE PROCEDURE "${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_PROCEDURE}"(`,
  );
}

export function validateOrgMetadataAcquisitionFirstPartySourceBackfillMigrationSql(
  migrationSql: string,
): readonly string[] {
  const statements = splitMigrationStatements(migrationSql);
  assert.equal(statements.length, 13);
  assert.match(statements[0] ?? "", /^-- vm0:non-transactional/mu);

  const preflight = requiredStatement(
    statements,
    "requires the accepted nullable no-default text columns",
  );
  const procedure = backfillProcedureStatement(statements);
  const postflight = requiredStatement(
    statements,
    "backfill procedure still exists",
  );
  assert.ok(statements.indexOf(preflight) < statements.indexOf(procedure));
  assert.ok(statements.indexOf(procedure) < statements.indexOf(postflight));

  for (const expected of [
    "requires the accepted nullable no-default text columns",
    "requires the exact enabled 1033 bridge",
    "found canonical-only rows",
    "found unequal dual rows",
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER.definition,
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION.bodyHash,
  ]) {
    assert.ok(preflight.includes(expected));
  }
  assert.match(preflight, /"trigger_row"\."tgenabled" = 'O'/u);
  assert.match(
    preflight,
    /"attribute_row"\."attname" = 'acquisition_vm0_source'[\s\S]*?NOT "attribute_row"\."attnotnull"[\s\S]*?"default_row"\."oid" IS NULL/u,
  );
  assert.match(
    preflight,
    /"attribute_row"\."attname" =\s+'acquisition_first_party_source'[\s\S]*?NOT "attribute_row"\."attnotnull"[\s\S]*?"default_row"\."oid" IS NULL/u,
  );
  assert.match(
    preflight,
    /"acquisition_vm0_source" IS NULL\s+AND "acquisition_first_party_source" IS NOT NULL/u,
  );
  assert.match(
    preflight,
    /"acquisition_vm0_source" IS NOT NULL\s+AND "acquisition_first_party_source" IS NOT NULL\s+AND "acquisition_vm0_source" IS DISTINCT FROM\s+"acquisition_first_party_source"/u,
  );

  assert.match(procedure, /v_scan_after text := NULL/u);
  assert.match(
    procedure,
    /"candidate"\."acquisition_vm0_source" IS NOT NULL\s+AND "candidate"\."acquisition_first_party_source" IS NULL\s+ORDER BY "candidate"\."org_id"\s+LIMIT 500\s+FOR UPDATE OF "candidate" SKIP LOCKED/u,
  );
  assert.match(
    procedure,
    /UPDATE "org_metadata" AS "target"\s+SET "acquisition_first_party_source" =\s+"batch"\."acquisition_vm0_source"\s+FROM "batch"/u,
  );
  assert.match(
    procedure,
    /WHERE "target"\."org_id" = "batch"\."org_id"\s+AND "target"\."acquisition_vm0_source" IS NOT NULL\s+AND "target"\."acquisition_first_party_source" IS NULL/u,
  );
  assert.equal(
    countOccurrences(procedure, 'UPDATE "org_metadata" AS "target"'),
    1,
  );
  assert.equal((procedure.match(/\bCOMMIT;/gu) ?? []).length, 1);
  assert.match(
    procedure,
    /COMMIT;\s+SET LOCAL lock_timeout = '1s';\s+SET LOCAL transaction_timeout = '5min';/u,
  );
  assert.match(procedure, /p_no_progress_timeout > interval '30 seconds'/u);
  assert.match(
    procedure,
    /made no progress for % while eligible rows remained/u,
  );
  assert.equal(
    statements.includes(
      `CALL "${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_PROCEDURE}"(interval '30 seconds');`,
    ),
    true,
  );
  assert.equal(
    statements.includes(
      `DROP PROCEDURE IF EXISTS "${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_PROCEDURE}"(interval);`,
    ),
    true,
  );

  for (const expected of [
    "left legacy-only rows",
    "left canonical-only rows",
    "left unequal dual rows",
    "did not preserve the exact enabled 1033 bridge",
    "backfill procedure still exists",
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER.definition,
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION.bodyHash,
  ]) {
    assert.ok(postflight.includes(expected));
  }

  const executableSql = migrationSql.replace(/^--.*$/gmu, "");
  assert.doesNotMatch(executableSql, /\bLOCK\s+TABLE\b/iu);
  assert.doesNotMatch(
    executableSql,
    /ALTER\s+TABLE\s+(?:public\.)?"?org_metadata"?/iu,
  );
  assert.doesNotMatch(
    executableSql,
    /\b(?:INSERT INTO|DELETE FROM|TRUNCATE)\s+(?:public\.)?"?org_metadata"?/iu,
  );
  assert.equal(
    countOccurrences(executableSql, 'UPDATE "org_metadata" AS "target"'),
    1,
  );
  assert.doesNotMatch(
    executableSql,
    /SET\s+"?(?:updated_at|acquisition_vm0_source)"?\s*=/iu,
  );
  for (const statement of statements) {
    const executableStatement = statement.replace(
      /^(?:--[^\n]*(?:\n|$)\s*)+/u,
      "",
    );
    assert.doesNotMatch(
      executableStatement,
      /^(?:(?:CREATE|REPLACE|DROP)\s+(?:TRIGGER|FUNCTION)\s+"?sync_org_metadata_acquisition_first_party_source_1033|ALTER\s+TABLE[\s\S]*?(?:DISABLE|ENABLE)\s+TRIGGER\s+"?sync_org_metadata_acquisition_first_party_source_1033)/iu,
    );
  }
  assert.doesNotMatch(executableSql, /\b(?:6295|4147|2142)\b/u);
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

async function applyStatementsUntilFailure(
  client: Client,
  statements: readonly string[],
): Promise<unknown> {
  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (error) {
      return error;
    }
  }
  throw new Error("Expected migration statements to fail");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readSnapshots(
  client: Client,
  prefix: string,
): Promise<readonly AcquisitionSourceSnapshot[]> {
  const result = await client.query<AcquisitionSourceSnapshot>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."acquisition_vm0_source" AS "legacy",
        "row"."acquisition_first_party_source" AS "canonical",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        to_jsonb("row") - 'acquisition_first_party_source' AS "rest"
      FROM "org_metadata" AS "row"
      WHERE "row"."org_id" LIKE $1
      ORDER BY "row"."org_id"
    `,
    [`${prefix}%`],
  );
  return result.rows;
}

function logicalSnapshot(row: AcquisitionSourceSnapshot): {
  readonly legacy: string | null;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
} {
  return { legacy: row.legacy, orgId: row.orgId, rest: row.rest };
}

async function orgMetadataRowCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM "org_metadata"`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function readClassification(
  client: Client,
  prefix: string,
): Promise<AcquisitionSourceClassification> {
  const result = await client.query<AcquisitionSourceClassification>(
    `
      SELECT
        count(*) FILTER (
          WHERE "acquisition_vm0_source" IS NULL
            AND "acquisition_first_party_source" IS NULL
        )::integer AS "bothNull",
        count(*) FILTER (
          WHERE "acquisition_vm0_source" IS NOT NULL
            AND "acquisition_first_party_source" IS NULL
        )::integer AS "legacyOnly",
        count(*) FILTER (
          WHERE "acquisition_vm0_source" IS NULL
            AND "acquisition_first_party_source" IS NOT NULL
        )::integer AS "canonicalOnly",
        count(*) FILTER (
          WHERE "acquisition_vm0_source" IS NOT NULL
            AND "acquisition_first_party_source" IS NOT NULL
            AND "acquisition_vm0_source" =
              "acquisition_first_party_source"
        )::integer AS "equal",
        count(*) FILTER (
          WHERE "acquisition_vm0_source" IS NOT NULL
            AND "acquisition_first_party_source" IS NOT NULL
            AND "acquisition_vm0_source" IS DISTINCT FROM
              "acquisition_first_party_source"
        )::integer AS "unequal"
      FROM "org_metadata"
      WHERE "org_id" LIKE $1
    `,
    [`${prefix}%`],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readBridgeCatalogIdentity(
  client: Client,
): Promise<readonly BridgeCatalogIdentity[]> {
  const result = await client.query<BridgeCatalogIdentity>(`
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
        AS "functionDefinition"
    FROM "pg_catalog"."pg_trigger" AS "trigger_row"
    INNER JOIN "pg_catalog"."pg_class" AS "table_row"
      ON "table_row"."oid" = "trigger_row"."tgrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "table_namespace"
      ON "table_namespace"."oid" = "table_row"."relnamespace"
    INNER JOIN "pg_catalog"."pg_proc" AS "function_row"
      ON "function_row"."oid" = "trigger_row"."tgfoid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "function_namespace"
      ON "function_namespace"."oid" = "function_row"."pronamespace"
    WHERE "table_namespace"."nspname" = 'public'
      AND "table_row"."relname" = 'org_metadata'
      AND "function_namespace"."nspname" = 'public'
      AND "trigger_row"."tgname" =
        'sync_org_metadata_acquisition_first_party_source_1033'
      AND NOT "trigger_row"."tgisinternal"
    ORDER BY "trigger_row"."tgname"
  `);
  assert.equal(result.rows.length, 1);
  assert.equal(
    result.rows[0]?.triggerDefinition,
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_TRIGGER.definition,
  );
  assert.equal(
    result.rows[0]?.bodyHash,
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_PERMANENT_FUNCTION.bodyHash,
  );
  return result.rows;
}

async function backfillProcedureCount(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `
      SELECT (
        to_regprocedure($1) IS NOT NULL
      )::integer AS "count"
    `,
    [
      `public.${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_PROCEDURE}(interval)`,
    ],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.count;
}

async function seedLegacyOnlyRows(
  client: Client,
  prefix: string,
  count: number,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `ALTER TABLE "org_metadata" DISABLE TRIGGER "${bridgeTriggerName}"`,
    );
    await client.query(
      `
        INSERT INTO "org_metadata" (
          "org_id", "credits", "onboarding_complete",
          "acquisition_vm0_source", "acquisition_first_party_source",
          "updated_at"
        )
        SELECT
          $1 || lpad("sequence_row"::text, 4, '0'),
          0,
          "sequence_row" % 2 = 0,
          CASE
            WHEN "sequence_row" % 2 = 0 THEN 'homepage'
            ELSE 'marketing'
          END,
          NULL,
          timestamp '2030-01-02 03:04:05'
        FROM generate_series(1, $2::integer) AS "sequence_row"
      `,
      [prefix, count],
    );
    await client.query(
      `ALTER TABLE "org_metadata" ENABLE TRIGGER "${bridgeTriggerName}"`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedBackfillProofRows(
  client: Client,
  prefix: string,
  legacyOnlyCount: number,
): Promise<BackfillProofFixture> {
  const legacyPrefix = `${prefix}-legacy-`;
  await seedLegacyOnlyRows(client, legacyPrefix, legacyOnlyCount);
  const bothNullOrgId = `${prefix}-both-null`;
  const equalOrgId = `${prefix}-equal`;
  await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "onboarding_complete", "updated_at"
      ) VALUES ($1, 0, true, timestamp '2031-02-03 04:05:06')
    `,
    [bothNullOrgId],
  );
  await client.query(
    `
      INSERT INTO "org_metadata" (
        "org_id", "credits", "onboarding_complete",
        "acquisition_vm0_source", "acquisition_first_party_source",
        "updated_at"
      ) VALUES (
        $1, 0, false, 'presentation', 'presentation',
        timestamp '2032-03-04 05:06:07'
      )
    `,
    [equalOrgId],
  );
  return {
    bothNullOrgId,
    equalOrgId,
    failureOrgId: `${legacyPrefix}${String(legacyOnlyCount).padStart(4, "0")}`,
    legacyOnlyCount,
    prefix,
  };
}

async function expectPreflightRejection(
  client: Client,
  preflight: string,
  mutation: string,
  expected: RegExp,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(mutation);
    let preflightError: unknown;
    try {
      await client.query(preflight);
    } catch (error) {
      preflightError = error;
    }
    assert.match(errorMessage(preflightError), expected);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function validateFailClosedPreflight(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  const preflight = requiredStatement(
    statements,
    "requires the accepted nullable no-default text columns",
  );
  const targetPrefix = "org-metadata-acquisition-30556-preflight-target-";
  await seedLegacyOnlyRows(client, targetPrefix, 1);
  const before = await readSnapshots(client, targetPrefix);
  try {
    await expectPreflightRejection(
      client,
      preflight,
      `DROP TRIGGER "${bridgeTriggerName}" ON "org_metadata"`,
      /requires the exact enabled 1033 bridge/u,
    );
    await expectPreflightRejection(
      client,
      preflight,
      `ALTER TABLE "org_metadata" DISABLE TRIGGER "${bridgeTriggerName}"`,
      /requires the exact enabled 1033 bridge/u,
    );
    await expectPreflightRejection(
      client,
      preflight,
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
      /requires the exact enabled 1033 bridge/u,
    );
    await expectPreflightRejection(
      client,
      preflight,
      `ALTER TABLE "org_metadata" ALTER COLUMN "acquisition_first_party_source" SET DEFAULT 'homepage'`,
      /requires the accepted nullable no-default text columns/u,
    );
    await expectPreflightRejection(
      client,
      preflight,
      `
        ALTER TABLE "org_metadata" DISABLE TRIGGER "${bridgeTriggerName}";
        INSERT INTO "org_metadata" (
          "org_id", "credits", "acquisition_first_party_source"
        ) VALUES (
          'org-metadata-acquisition-30556-preflight-canonical-only',
          0,
          'homepage'
        );
        ALTER TABLE "org_metadata" ENABLE TRIGGER "${bridgeTriggerName}"
      `,
      /found canonical-only rows/u,
    );
    await expectPreflightRejection(
      client,
      preflight,
      `
        ALTER TABLE "org_metadata" DISABLE TRIGGER "${bridgeTriggerName}";
        INSERT INTO "org_metadata" (
          "org_id", "credits", "acquisition_vm0_source",
          "acquisition_first_party_source"
        ) VALUES (
          'org-metadata-acquisition-30556-preflight-unequal',
          0,
          'homepage',
          'marketing'
        );
        ALTER TABLE "org_metadata" ENABLE TRIGGER "${bridgeTriggerName}"
      `,
      /found unequal dual rows/u,
    );
    assert.deepEqual(await readSnapshots(client, targetPrefix), before);
  } finally {
    await client.query(`DELETE FROM "org_metadata" WHERE "org_id" LIKE $1`, [
      `${targetPrefix}%`,
    ]);
  }
}

async function installPartialFailureTrigger(
  client: Client,
  failureOrgId: string,
): Promise<void> {
  await client.query(`
    CREATE FUNCTION public.${partialFailureFunctionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      RAISE EXCEPTION 'forced partial acquisition backfill interruption';
    END;
    $body$
  `);
  await client.query(`
    CREATE TRIGGER ${partialFailureTriggerName}
    BEFORE UPDATE OF "acquisition_first_party_source"
    ON "org_metadata"
    FOR EACH ROW
    WHEN (NEW."org_id" = '${failureOrgId}')
    EXECUTE FUNCTION public.${partialFailureFunctionName}()
  `);
}

async function dropPartialFailureTrigger(client: Client): Promise<void> {
  await client.query(
    `DROP TRIGGER IF EXISTS ${partialFailureTriggerName} ON "org_metadata"`,
  );
  await client.query(
    `DROP FUNCTION IF EXISTS public.${partialFailureFunctionName}()`,
  );
}

async function validateBackfillResult(
  client: Client,
  fixture: BackfillProofFixture,
  before: readonly AcquisitionSourceSnapshot[],
  beforeCount: number,
): Promise<void> {
  const after = await readSnapshots(client, fixture.prefix);
  assert.deepEqual(after.map(logicalSnapshot), before.map(logicalSnapshot));
  assert.equal(await orgMetadataRowCount(client), beforeCount);
  assert.deepEqual(await readClassification(client, fixture.prefix), {
    bothNull: 1,
    canonicalOnly: 0,
    equal: fixture.legacyOnlyCount + 1,
    legacyOnly: 0,
    unequal: 0,
  });
  for (const row of after) {
    assert.equal(row.canonical, row.legacy);
  }

  const beforeByOrgId = new Map(
    before.map((row) => {
      return [row.orgId, row] as const;
    }),
  );
  for (const orgId of [fixture.bothNullOrgId, fixture.equalOrgId]) {
    const beforeRow = beforeByOrgId.get(orgId);
    const afterRow = after.find((row) => {
      return row.orgId === orgId;
    });
    assert.ok(beforeRow);
    assert.ok(afterRow);
    assert.equal(afterRow.ctid, beforeRow.ctid);
    assert.equal(afterRow.xmin, beforeRow.xmin);
  }
}

async function validatePartialRerunAndIdempotency(
  client: Client,
  statements: readonly string[],
): Promise<void> {
  const fixture = await seedBackfillProofRows(
    client,
    "org-metadata-acquisition-30556-replay",
    1001,
  );
  const before = await readSnapshots(client, fixture.prefix);
  const beforeCount = await orgMetadataRowCount(client);
  const catalogBefore = await readBridgeCatalogIdentity(client);
  await installPartialFailureTrigger(client, fixture.failureOrgId);
  const partialError = await applyStatementsUntilFailure(client, statements);
  assert.match(
    errorMessage(partialError),
    /forced partial acquisition backfill interruption/u,
  );
  await client.query("ROLLBACK");
  try {
    assert.deepEqual(await readClassification(client, fixture.prefix), {
      bothNull: 1,
      canonicalOnly: 0,
      equal: 1001,
      legacyOnly: 1,
      unequal: 0,
    });
    assert.equal(await backfillProcedureCount(client), 1);
  } finally {
    await dropPartialFailureTrigger(client);
  }

  await applyStatements(client, statements);
  await validateBackfillResult(client, fixture, before, beforeCount);
  assert.deepEqual(await readBridgeCatalogIdentity(client), catalogBefore);
  assert.equal(await backfillProcedureCount(client), 0);

  const beforeNoOp = await readSnapshots(client, fixture.prefix);
  const beforeNoOpCount = await orgMetadataRowCount(client);
  await applyMigrationsFromDirectoryUpToTag(
    client,
    migrationsDirectory,
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_MIGRATION,
  );
  assert.deepEqual(await readSnapshots(client, fixture.prefix), beforeNoOp);
  assert.equal(await orgMetadataRowCount(client), beforeNoOpCount);
  assert.deepEqual(await readBridgeCatalogIdentity(client), catalogBefore);
  assert.equal(await backfillProcedureCount(client), 0);
}

export async function validateOrgMetadataAcquisitionFirstPartySourceBackfill(
  baseDbUrl: string,
): Promise<void> {
  console.log(
    "=== Validate org metadata acquisition first-party source backfill ===\n",
  );
  const migrationSql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_BACKFILL_MIGRATION}.sql`,
    ),
    "utf8",
  );
  const statements =
    validateOrgMetadataAcquisitionFirstPartySourceBackfillMigrationSql(
      migrationSql,
    );

  const dbUrl = await createDatabase(baseDbUrl);
  try {
    const client = await connect(dbUrl);
    try {
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION,
      );
      await validateFailClosedPreflight(client, statements);
      await validatePartialRerunAndIdempotency(client, statements);
    } finally {
      await client.end();
    }

    await validatePermanentOrgMetadataAcquisitionFirstPartySourceState(dbUrl);
    console.log(
      "   ✅ exact column and 1033 bridge drift fail before mutation",
    );
    console.log(
      "   ✅ historical legacy-only rows are copied in bounded batches",
    );
    console.log(
      "   ✅ interrupted and completed reruns preserve parity, unrelated data, and bridge identity\n",
    );
  } finally {
    await dropDatabase(baseDbUrl);
  }
}

export async function validateOrgMetadataAcquisitionFirstPartySourceBackfillOnRegeneratedSchema(
  dbUrl: string,
  migrationSql: string,
): Promise<void> {
  const statements =
    validateOrgMetadataAcquisitionFirstPartySourceBackfillMigrationSql(
      migrationSql,
    );
  const client = await connect(dbUrl);
  try {
    const fixture = await seedBackfillProofRows(
      client,
      "org-metadata-acquisition-30556-regenerated",
      2,
    );
    const before = await readSnapshots(client, fixture.prefix);
    const beforeCount = await orgMetadataRowCount(client);
    const catalogBefore = await readBridgeCatalogIdentity(client);
    await applyStatements(client, statements);
    await validateBackfillResult(client, fixture, before, beforeCount);
    assert.deepEqual(await readBridgeCatalogIdentity(client), catalogBefore);

    const beforeNoOp = await readSnapshots(client, fixture.prefix);
    await applyStatements(client, statements);
    assert.deepEqual(await readSnapshots(client, fixture.prefix), beforeNoOp);
    assert.deepEqual(await readBridgeCatalogIdentity(client), catalogBefore);
    assert.equal(await backfillProcedureCount(client), 0);
  } finally {
    await client.end();
  }
}
