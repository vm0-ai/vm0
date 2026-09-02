import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { validatePermanentOrgMetadataAcquisitionFirstPartySourceState } from "./test-org-metadata-acquisition-first-party-source-permanent";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");
const preContractMigration = "1049_mushy_deadpool";
export const ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_CONTRACT_MIGRATION =
  "1050_watery_the_renegades";

const successDatabaseName = "migration_org_metadata_acquisition_contract_30985";
const refusalDatabaseName =
  "migration_org_metadata_acquisition_contract_refusal_30985";
const bridgeTriggerName =
  "sync_org_metadata_acquisition_first_party_source_1033";

// Test-only shape pinned to the accepted #30605 authority-switch release.
const authoritySwitchOrgMetadata = pgTable("org_metadata", {
  orgId: text("org_id").primaryKey(),
  acquisitionFirstPartySource: text("acquisition_first_party_source"),
});

interface CanonicalRowSnapshot {
  readonly canonical: string | null;
  readonly ctid: string;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
  readonly xmin: string;
}

function databaseErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "";
  }
  const message = Reflect.get(error, "message");
  return typeof message === "string" ? message : "";
}

function createDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function executeOnAdminDatabase(
  baseUrl: string,
  sql: string,
): Promise<void> {
  const client = new Client({
    connectionString: createDatabaseUrl(baseUrl, "postgres"),
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(
  baseUrl: string,
  databaseName: string,
): Promise<string> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
  );
  await executeOnAdminDatabase(baseUrl, `CREATE DATABASE "${databaseName}"`);
  return createDatabaseUrl(baseUrl, databaseName);
}

async function dropDatabase(
  baseUrl: string,
  databaseName: string,
): Promise<void> {
  await executeOnAdminDatabase(
    baseUrl,
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
  );
}

async function applyThrough(client: Client, tag: string): Promise<void> {
  await applyMigrationsFromDirectoryUpToTag(client, migrationsDirectory, tag);
}

function splitContractStatements(migrationSql: string): readonly string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
}

async function readContractMigrationSql(): Promise<string> {
  return fs.readFile(
    path.join(
      migrationsDirectory,
      `${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_CONTRACT_MIGRATION}.sql`,
    ),
    "utf8",
  );
}

async function validateMigrationScope(): Promise<void> {
  const migrationSql = await readContractMigrationSql();
  const statements = splitContractStatements(migrationSql);
  assert.equal(statements.length, 9);
  assert.match(statements[0] ?? "", /^SET LOCAL lock_timeout = '1s';$/u);
  assert.match(statements[1] ?? "", /^SET LOCAL statement_timeout = '10s';$/u);
  assert.match(
    statements[2] ?? "",
    /LOCK TABLE "org_metadata" IN ACCESS EXCLUSIVE MODE;$/u,
  );
  assert.match(
    statements[3] ?? "",
    /requires the accepted enabled 1033 bridge identity/u,
  );
  assert.match(
    statements[3] ?? "",
    /requires matching nullable acquisition pairs/u,
  );
  assert.match(
    statements[4] ?? "",
    /^CREATE TEMP TABLE "org_metadata_acquisition_contract_state_1050"/u,
  );
  assert.match(
    statements[5] ?? "",
    /^DROP TRIGGER "sync_org_metadata_acquisition_first_party_source_1033"/u,
  );
  assert.match(
    statements[6] ?? "",
    /^DROP FUNCTION public\."sync_org_metadata_acquisition_first_party_source_1033"\(\);$/u,
  );
  assert.match(
    statements[7] ?? "",
    /^ALTER TABLE "org_metadata"[\s\S]*DROP COLUMN "acquisition_vm0_source";$/u,
  );
  assert.match(statements[8] ?? "", /did not preserve the canonical row set/u);
  assert.doesNotMatch(migrationSql, /\bCASCADE\b/u);
  assert.doesNotMatch(migrationSql, /UPDATE\s+"org_metadata"/iu);
}

export async function applyOrgMetadataAcquisitionFirstPartySourceContractOnRegeneratedSchema(
  dbUrl: string,
  migrationSql: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  await client.query("BEGIN");
  try {
    for (const statement of splitContractStatements(migrationSql)) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function readCanonicalRows(
  client: Client,
  orgIds: readonly string[],
  legacyColumnPresent: boolean,
): Promise<readonly CanonicalRowSnapshot[]> {
  const legacyRemoval = legacyColumnPresent
    ? "to_jsonb(\"row\") - 'acquisition_vm0_source'"
    : 'to_jsonb("row")';
  const result = await client.query<CanonicalRowSnapshot>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."acquisition_first_party_source" AS "canonical",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        ${legacyRemoval} AS "rest"
      FROM "org_metadata" AS "row"
      WHERE "row"."org_id" = ANY($1::text[])
      ORDER BY "row"."org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

async function exerciseAuthoritySwitchApplicationStatements(
  database: NodePgDatabase<Record<string, never>>,
  prefix: string,
): Promise<void> {
  const orgId = `${prefix}-row`;
  const deleteOrgId = `${prefix}-delete`;
  const [inserted] = await database
    .insert(authoritySwitchOrgMetadata)
    .values({ orgId, acquisitionFirstPartySource: "homepage" })
    .returning({
      canonical: authoritySwitchOrgMetadata.acquisitionFirstPartySource,
    });
  assert.deepEqual(inserted, { canonical: "homepage" });

  const [selected] = await database
    .select({
      canonical: authoritySwitchOrgMetadata.acquisitionFirstPartySource,
    })
    .from(authoritySwitchOrgMetadata)
    .where(eq(authoritySwitchOrgMetadata.orgId, orgId));
  assert.deepEqual(selected, { canonical: "homepage" });

  const [ignored] = await database
    .insert(authoritySwitchOrgMetadata)
    .values({ orgId, acquisitionFirstPartySource: "marketing" })
    .onConflictDoNothing({ target: authoritySwitchOrgMetadata.orgId })
    .returning({ orgId: authoritySwitchOrgMetadata.orgId });
  assert.equal(ignored, undefined);

  const [upserted] = await database
    .insert(authoritySwitchOrgMetadata)
    .values({ orgId, acquisitionFirstPartySource: "marketing" })
    .onConflictDoUpdate({
      target: authoritySwitchOrgMetadata.orgId,
      set: { acquisitionFirstPartySource: "marketing" },
    })
    .returning({
      canonical: authoritySwitchOrgMetadata.acquisitionFirstPartySource,
    });
  assert.deepEqual(upserted, { canonical: "marketing" });

  await database
    .update(authoritySwitchOrgMetadata)
    .set({ acquisitionFirstPartySource: "presentation" })
    .where(eq(authoritySwitchOrgMetadata.orgId, orgId));

  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        canonical: authoritySwitchOrgMetadata.acquisitionFirstPartySource,
      })
      .from(authoritySwitchOrgMetadata)
      .where(eq(authoritySwitchOrgMetadata.orgId, orgId))
      .for("update");
    assert.deepEqual(locked, { canonical: "presentation" });
  });

  await database
    .insert(authoritySwitchOrgMetadata)
    .values({ orgId: deleteOrgId, acquisitionFirstPartySource: null });
  const [deleted] = await database
    .delete(authoritySwitchOrgMetadata)
    .where(eq(authoritySwitchOrgMetadata.orgId, deleteOrgId))
    .returning({ orgId: authoritySwitchOrgMetadata.orgId });
  assert.deepEqual(deleted, { orgId: deleteOrgId });
}

async function exerciseCurrentApplicationStatements(
  database: NodePgDatabase<Record<string, never>>,
  prefix: string,
): Promise<void> {
  const orgId = `${prefix}-row`;
  const nullOrgId = `${prefix}-null`;
  const [inserted] = await database
    .insert(orgMetadataCanonicalWrites)
    .values({
      orgId,
      acquisitionFirstPartySource: "homepage",
    })
    .returning({
      canonical: orgMetadataCanonicalWrites.acquisitionFirstPartySource,
    });
  assert.deepEqual(inserted, { canonical: "homepage" });

  await database
    .insert(orgMetadataCanonicalWrites)
    .values({ orgId: nullOrgId, acquisitionFirstPartySource: null });

  await database
    .update(orgMetadata)
    .set({ acquisitionFirstPartySource: "marketing" })
    .where(eq(orgMetadata.orgId, orgId));

  const [selected] = await database
    .select({
      canonical: orgMetadata.acquisitionFirstPartySource,
      orgId: orgMetadata.orgId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId));
  assert.deepEqual(selected, { canonical: "marketing", orgId });

  const [nullSelected] = await database
    .select({ canonical: orgMetadata.acquisitionFirstPartySource })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, nullOrgId));
  assert.deepEqual(nullSelected, { canonical: null });
}

async function assertTransitionObjectsStillPresent(
  dbUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const inventory = await client.query<{
      functionCount: number;
      legacyColumnCount: number;
      triggerCount: number;
    }>(`
      SELECT
        (
          SELECT count(*)::integer
          FROM "pg_catalog"."pg_proc" AS "function_row"
          INNER JOIN "pg_catalog"."pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "function_row"."pronamespace"
          WHERE "namespace_row"."nspname" = 'public'
            AND "function_row"."proname" = '${bridgeTriggerName}'
        ) AS "functionCount",
        (
          SELECT count(*)::integer
          FROM "pg_catalog"."pg_attribute"
          WHERE "attrelid" = 'public.org_metadata'::regclass
            AND "attname" = 'acquisition_vm0_source'
            AND NOT "attisdropped"
        ) AS "legacyColumnCount",
        (
          SELECT count(*)::integer
          FROM "pg_catalog"."pg_trigger"
          WHERE "tgname" = '${bridgeTriggerName}'
            AND NOT "tgisinternal"
        ) AS "triggerCount"
    `);
    assert.deepEqual(inventory.rows, [
      { functionCount: 1, legacyColumnCount: 1, triggerCount: 1 },
    ]);
  } finally {
    await client.end();
  }
}

async function expectContractFailure(
  dbUrl: string,
  expectedMessage: RegExp,
): Promise<void> {
  let migrationError: unknown;
  try {
    await applyOrgMetadataAcquisitionFirstPartySourceContractOnRegeneratedSchema(
      dbUrl,
      await readContractMigrationSql(),
    );
  } catch (error) {
    migrationError = error;
  }
  assert.ok(
    migrationError,
    `Expected contract failure ${String(expectedMessage)}`,
  );
  assert.match(databaseErrorMessage(migrationError), expectedMessage);
  await assertTransitionObjectsStillPresent(dbUrl);
}

async function validateSuccessfulReplay(baseUrl: string): Promise<void> {
  const dbUrl = await createDatabase(baseUrl, successDatabaseName);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await applyThrough(client, preContractMigration);
      const database = drizzle(client);
      const bothNullOrgId = "org-metadata-acquisition-contract-30985-both-null";
      const equalOrgId = "org-metadata-acquisition-contract-30985-equal";
      await client.query(
        `
          INSERT INTO "org_metadata" (
            "org_id", "acquisition_vm0_source",
            "acquisition_first_party_source"
          ) VALUES ($1, NULL, NULL), ($2, 'calendar', 'calendar')
        `,
        [bothNullOrgId, equalOrgId],
      );
      await exerciseAuthoritySwitchApplicationStatements(
        database,
        "org-metadata-acquisition-contract-30985-before",
      );

      const preservedOrgIds = [
        bothNullOrgId,
        equalOrgId,
        "org-metadata-acquisition-contract-30985-before-row",
      ].sort();
      const before = await readCanonicalRows(client, preservedOrgIds, true);
      assert.equal(before.length, preservedOrgIds.length);

      await applyOrgMetadataAcquisitionFirstPartySourceContractOnRegeneratedSchema(
        dbUrl,
        await readContractMigrationSql(),
      );

      const after = await readCanonicalRows(client, preservedOrgIds, false);
      assert.deepEqual(after, before);
      await exerciseAuthoritySwitchApplicationStatements(
        database,
        "org-metadata-acquisition-contract-30985-authority",
      );
      await exerciseCurrentApplicationStatements(
        database,
        "org-metadata-acquisition-contract-30985-current",
      );
    } finally {
      await client.end();
    }
    await validatePermanentOrgMetadataAcquisitionFirstPartySourceState(dbUrl);
  } finally {
    await dropDatabase(baseUrl, successDatabaseName);
  }
}

async function setPairState(
  client: Client,
  legacy: string | null,
  canonical: string | null,
): Promise<void> {
  await client.query(
    `ALTER TABLE "org_metadata" DISABLE TRIGGER "${bridgeTriggerName}"`,
  );
  try {
    await client.query(
      `
        UPDATE "org_metadata"
        SET
          "acquisition_vm0_source" = $1,
          "acquisition_first_party_source" = $2
        WHERE "org_id" = 'org-metadata-acquisition-contract-30985-refusal'
      `,
      [legacy, canonical],
    );
  } finally {
    await client.query(
      `ALTER TABLE "org_metadata" ENABLE TRIGGER "${bridgeTriggerName}"`,
    );
  }
}

async function validateRefusalReplay(baseUrl: string): Promise<void> {
  const dbUrl = await createDatabase(baseUrl, refusalDatabaseName);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await applyThrough(client, preContractMigration);
      await client.query(`
        INSERT INTO "org_metadata" (
          "org_id", "acquisition_vm0_source",
          "acquisition_first_party_source"
        ) VALUES (
          'org-metadata-acquisition-contract-30985-refusal', NULL, NULL
        )
      `);

      await client.query(`
        ALTER TABLE "org_metadata"
        ALTER COLUMN "acquisition_vm0_source" SET DEFAULT 'homepage'
      `);
      await expectContractFailure(dbUrl, /unexpected column catalog/u);
      await client.query(`
        ALTER TABLE "org_metadata"
        ALTER COLUMN "acquisition_vm0_source" DROP DEFAULT
      `);

      await client.query(`
        ALTER TABLE "org_metadata" DROP CONSTRAINT "org_metadata_pkey";
        ALTER TABLE "org_metadata"
        ADD CONSTRAINT "org_metadata_org_id_key" UNIQUE ("org_id")
      `);
      await expectContractFailure(dbUrl, /exact org_id primary key/u);
      await client.query(`
        ALTER TABLE "org_metadata"
        DROP CONSTRAINT "org_metadata_org_id_key";
        ALTER TABLE "org_metadata"
        ADD CONSTRAINT "org_metadata_pkey" PRIMARY KEY ("org_id")
      `);

      await client.query(`
        ALTER TABLE "org_metadata" DISABLE TRIGGER "${bridgeTriggerName}"
      `);
      await expectContractFailure(
        dbUrl,
        /accepted enabled 1033 bridge identity/u,
      );
      await client.query(`
        ALTER TABLE "org_metadata" ENABLE TRIGGER "${bridgeTriggerName}"
      `);

      await client.query(`
        ALTER FUNCTION public."${bridgeTriggerName}"() SECURITY DEFINER
      `);
      await expectContractFailure(
        dbUrl,
        /accepted enabled 1033 bridge identity/u,
      );
      await client.query(`
        ALTER FUNCTION public."${bridgeTriggerName}"() SECURITY INVOKER
      `);

      await client.query(`
        CREATE VIEW "org_metadata_acquisition_legacy_dependency_30985" AS
        SELECT "acquisition_vm0_source" FROM "org_metadata"
      `);
      await expectContractFailure(dbUrl, /unexpected column dependencies/u);
      await client.query(
        `DROP VIEW "org_metadata_acquisition_legacy_dependency_30985"`,
      );

      await client.query(`
        CREATE VIEW "org_metadata_acquisition_canonical_dependency_30985" AS
        SELECT "acquisition_first_party_source" FROM "org_metadata"
      `);
      await expectContractFailure(dbUrl, /unexpected column dependencies/u);
      await client.query(
        `DROP VIEW "org_metadata_acquisition_canonical_dependency_30985"`,
      );

      await client.query(`
        CREATE FUNCTION public.unexpected_acquisition_reader_30985()
        RETURNS text
        LANGUAGE plpgsql
        AS $body$
        DECLARE source text;
        BEGIN
          SELECT "acquisition_vm0_source" INTO source
          FROM public."org_metadata" LIMIT 1;
          RETURN source;
        END;
        $body$
      `);
      await expectContractFailure(
        dbUrl,
        /unexpected routines referencing acquisition_vm0_source/u,
      );
      await client.query(
        `DROP FUNCTION public.unexpected_acquisition_reader_30985()`,
      );

      await setPairState(client, "homepage", null);
      await expectContractFailure(
        dbUrl,
        /requires matching nullable acquisition pairs/u,
      );
      await setPairState(client, null, null);

      await setPairState(client, null, "marketing");
      await expectContractFailure(
        dbUrl,
        /requires matching nullable acquisition pairs/u,
      );
      await setPairState(client, null, null);

      await setPairState(client, "homepage", "marketing");
      await expectContractFailure(
        dbUrl,
        /requires matching nullable acquisition pairs/u,
      );
      await setPairState(client, "homepage", "homepage");

      await applyOrgMetadataAcquisitionFirstPartySourceContractOnRegeneratedSchema(
        dbUrl,
        await readContractMigrationSql(),
      );
    } finally {
      await client.end();
    }
    await validatePermanentOrgMetadataAcquisitionFirstPartySourceState(dbUrl);
  } finally {
    await dropDatabase(baseUrl, refusalDatabaseName);
  }
}

export async function validateOrgMetadataAcquisitionFirstPartySourceContract(
  baseUrl: string,
): Promise<void> {
  console.log(
    "=== Validate org metadata acquisition first-party source contract ===\n",
  );
  await validateMigrationScope();
  await validateSuccessfulReplay(baseUrl);
  await validateRefusalReplay(baseUrl);
  console.log(
    "   ✅ authority-switch and current canonical application SQL shapes pass",
  );
  console.log(
    "   ✅ both-NULL and equal canonical rows preserve value, ctid, xmin, and non-legacy payload",
  );
  console.log(
    "   ✅ catalog drift, dependencies, stored readers, and all unequal pair states refuse transactionally\n",
  );
}
