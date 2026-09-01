import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orgPlanEntitlementsCanonicalWrites } from "@okouai/db/operations/org-plan-entitlement-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/schema/org-plan-entitlement";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { boolean, integer, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";

import { loadOrgPlanCapabilities } from "../../../apps/api/src/signals/services/org-plan-entitlement-read.service";
import { upsertOrgPlanEntitlement } from "../../../apps/api/src/signals/services/org-plan-entitlements.service";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import { validatePermanentOrgPlanEntitlementRestrictionState } from "./test-org-plan-entitlement-restriction-permanent";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");
const preContractMigration = "1040_custom_connector_automatic_oauth";
export const ORG_PLAN_ENTITLEMENT_RESTRICTION_CONTRACT_MIGRATION =
  "1041_contract_legacy_org_plan_entitlement_restriction";

const successDatabaseName = "migration_org_plan_restriction_contract_30757";
const refusalDatabaseName =
  "migration_org_plan_restriction_contract_refusal_30757";

const authoritySwitchOrgPlanEntitlements = pgTable("org_plan_entitlements", {
  orgId: text("org_id").primaryKey(),
  planKey: text("plan_key").notNull(),
  planRank: integer("plan_rank").notNull(),
  source: varchar("source", { length: 50 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  restrictedVm0Models: boolean("restricted_vm0_models").notNull().default(true),
  restrictedBuiltInModels: boolean("restricted_built_in_models").notNull(),
});

interface CanonicalRowSnapshot {
  readonly canonical: boolean;
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
      `${ORG_PLAN_ENTITLEMENT_RESTRICTION_CONTRACT_MIGRATION}.sql`,
    ),
    "utf8",
  );
}

async function validateMigrationScope(): Promise<void> {
  const migrationSql = await readContractMigrationSql();
  const statements = splitContractStatements(migrationSql);
  assert.equal(statements.length, 10);
  assert.match(statements[0] ?? "", /^SET LOCAL lock_timeout = '1s';$/u);
  assert.match(statements[1] ?? "", /^SET LOCAL statement_timeout = '10s';$/u);
  assert.match(
    statements[2] ?? "",
    /LOCK TABLE[\s\S]*"org_metadata"[\s\S]*"org_plan_entitlements"[\s\S]*IN ACCESS EXCLUSIVE MODE;$/u,
  );
  assert.match(
    statements[3] ?? "",
    /requires the accepted enabled 1023 bridge identity/u,
  );
  assert.match(
    statements[4] ?? "",
    /^CREATE TEMP TABLE "org_plan_entitlement_contract_state_1041"/u,
  );
  assert.match(
    statements[5] ?? "",
    /^CREATE OR REPLACE FUNCTION public\.ensure_legacy_org_metadata_plan_entitlement\(\)/u,
  );
  assert.match(statements[5] ?? "", /ON CONFLICT \("org_id"\) DO NOTHING/u);
  assert.doesNotMatch(statements[5] ?? "", /restricted_vm0_models/u);
  assert.match(
    statements[6] ?? "",
    /^DROP TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"/u,
  );
  assert.match(
    statements[7] ?? "",
    /^DROP FUNCTION public\."sync_org_plan_entitlement_model_restrictions_1023"\(\);$/u,
  );
  assert.match(
    statements[8] ?? "",
    /^ALTER TABLE "org_plan_entitlements"[\s\S]*DROP COLUMN "restricted_vm0_models";$/u,
  );
  assert.match(statements[9] ?? "", /did not preserve the canonical row set/u);
  assert.doesNotMatch(migrationSql, /\bCASCADE\b/u);
  assert.doesNotMatch(migrationSql, /UPDATE\s+"org_plan_entitlements"/iu);
  assert.doesNotMatch(
    migrationSql,
    /SET\s+"restricted_built_in_models"\s*=\s*"restricted_vm0_models"/iu,
  );
}

export async function applyOrgPlanEntitlementRestrictionContractOnRegeneratedSchema(
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
    ? "to_jsonb(\"row\") - 'restricted_vm0_models'"
    : 'to_jsonb("row")';
  const result = await client.query<CanonicalRowSnapshot>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."restricted_built_in_models" AS "canonical",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        ${legacyRemoval} AS "rest"
      FROM "org_plan_entitlements" AS "row"
      WHERE "row"."org_id" = ANY($1::text[])
      ORDER BY "row"."org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

async function exerciseAuthoritySwitchApplicationStatements(
  database: NodePgDatabase<Record<string, never>>,
  orgId: string,
): Promise<void> {
  const [inserted] = await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: false,
    })
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(inserted, { canonical: false });

  const [selected] = await database
    .select({
      canonical: authoritySwitchOrgPlanEntitlements.restrictedBuiltInModels,
    })
    .from(authoritySwitchOrgPlanEntitlements)
    .where(eq(authoritySwitchOrgPlanEntitlements.orgId, orgId))
    .limit(1);
  assert.deepEqual(selected, { canonical: false });

  await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: true,
    })
    .onConflictDoUpdate({
      target: orgPlanEntitlementsCanonicalWrites.orgId,
      set: { restrictedBuiltInModels: true },
    });
  await database
    .update(authoritySwitchOrgPlanEntitlements)
    .set({ restrictedBuiltInModels: false })
    .where(eq(authoritySwitchOrgPlanEntitlements.orgId, orgId));

  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        canonical: authoritySwitchOrgPlanEntitlements.restrictedBuiltInModels,
      })
      .from(authoritySwitchOrgPlanEntitlements)
      .where(eq(authoritySwitchOrgPlanEntitlements.orgId, orgId))
      .limit(1)
      .for("update");
    assert.deepEqual(locked, { canonical: false });
  });

  const deleteOrgId = `${orgId}-delete`;
  await database.insert(orgPlanEntitlementsCanonicalWrites).values({
    orgId: deleteOrgId,
    planKey: "fixture",
    planRank: 0,
    source: "test_fixture",
    restrictedBuiltInModels: true,
  });
  const [deleted] = await database
    .delete(authoritySwitchOrgPlanEntitlements)
    .where(eq(authoritySwitchOrgPlanEntitlements.orgId, deleteOrgId))
    .returning({ orgId: authoritySwitchOrgPlanEntitlements.orgId });
  assert.deepEqual(deleted, { orgId: deleteOrgId });
}

async function exerciseCanonicalApplicationStatements(
  database: NodePgDatabase<Record<string, never>>,
  orgId: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    await upsertOrgPlanEntitlement(tx, {
      orgId,
      source: "org_metadata_bootstrap",
      tier: "free",
    });
  });
  const freeCapabilities = await loadOrgPlanCapabilities(database, orgId);
  assert.equal(freeCapabilities?.restrictedVm0Models, false);

  await database.transaction(async (tx) => {
    const locked = await loadOrgPlanCapabilities(tx, orgId, {
      forUpdate: true,
    });
    assert.equal(locked?.restrictedVm0Models, false);
  });

  const [selected] = await database
    .select({
      canonical: orgPlanEntitlements.restrictedBuiltInModels,
      orgId: orgPlanEntitlements.orgId,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  assert.deepEqual(selected, { canonical: false, orgId });

  const [returned] = await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId: `${orgId}-returning`,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: true,
    })
    .returning({
      canonical: orgPlanEntitlementsCanonicalWrites.restrictedBuiltInModels,
    });
  assert.deepEqual(returned, { canonical: true });

  await database
    .insert(orgPlanEntitlementsCanonicalWrites)
    .values({
      orgId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedBuiltInModels: true,
    })
    .onConflictDoUpdate({
      target: orgPlanEntitlementsCanonicalWrites.orgId,
      set: { restrictedBuiltInModels: true },
    });
  await database
    .update(orgPlanEntitlements)
    .set({ restrictedBuiltInModels: false })
    .where(eq(orgPlanEntitlements.orgId, orgId));

  const [updated] = await database
    .select({ canonical: orgPlanEntitlements.restrictedBuiltInModels })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId));
  assert.deepEqual(updated, { canonical: false });

  const [deleted] = await database
    .delete(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, `${orgId}-returning`))
    .returning({ orgId: orgPlanEntitlements.orgId });
  assert.deepEqual(deleted, { orgId: `${orgId}-returning` });
}

async function expectContractFailure(
  dbUrl: string,
  expectedMessage: RegExp,
): Promise<void> {
  let migrationError: unknown;
  try {
    await applyOrgPlanEntitlementRestrictionContractOnRegeneratedSchema(
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
}

async function validateSuccessfulReplay(baseUrl: string): Promise<void> {
  const dbUrl = await createDatabase(baseUrl, successDatabaseName);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await applyThrough(client, preContractMigration);
      const database = drizzle(client);
      const authorityOrgId = "org-plan-contract-30757-authority-switch";
      const helperOrgId = "org-plan-contract-30757-helper-before-contract";
      const directOrgId = "org-plan-contract-30757-direct-before-contract";
      await client.query(
        `
          INSERT INTO "org_plan_entitlements" (
            "org_id", "plan_key", "plan_rank", "source",
            "restricted_vm0_models", "restricted_built_in_models"
          ) VALUES ($1, 'fixture', 0, 'test_fixture', false, false)
        `,
        [authorityOrgId],
      );
      await client.query(
        `INSERT INTO "org_metadata" ("org_id", "tier", "credits") VALUES ($1, 'team', 0)`,
        [helperOrgId],
      );
      await client.query(
        `
          INSERT INTO "org_plan_entitlements" (
            "org_id", "plan_key", "plan_rank", "source",
            "restricted_vm0_models", "restricted_built_in_models"
          ) VALUES ($1, 'fixture', 0, 'test_fixture', true, true)
        `,
        [directOrgId],
      );

      const preservedOrgIds = [authorityOrgId, directOrgId, helperOrgId].sort();
      const before = await readCanonicalRows(client, preservedOrgIds, true);
      assert.equal(before.length, preservedOrgIds.length);

      await applyOrgPlanEntitlementRestrictionContractOnRegeneratedSchema(
        dbUrl,
        await readContractMigrationSql(),
      );

      const after = await readCanonicalRows(client, preservedOrgIds, false);
      assert.deepEqual(after, before);
      await exerciseAuthoritySwitchApplicationStatements(
        database,
        "org-plan-contract-30757-rollback-app",
      );
      await exerciseCanonicalApplicationStatements(
        database,
        "org-plan-contract-30757-current-app",
      );
    } finally {
      await client.end();
    }
    await validatePermanentOrgPlanEntitlementRestrictionState(dbUrl);
  } finally {
    await dropDatabase(baseUrl, successDatabaseName);
  }
}

async function validateRefusalReplay(baseUrl: string): Promise<void> {
  const dbUrl = await createDatabase(baseUrl, refusalDatabaseName);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await applyThrough(client, preContractMigration);
      await client.query(
        `
          INSERT INTO "org_plan_entitlements" (
            "org_id", "plan_key", "plan_rank", "source",
            "restricted_vm0_models", "restricted_built_in_models"
          ) VALUES ('org-plan-contract-30757-refusal', 'fixture', 0, 'test_fixture', true, true)
        `,
      );

      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        ALTER COLUMN "restricted_vm0_models" DROP DEFAULT
      `);
      await expectContractFailure(
        dbUrl,
        /unexpected restriction column catalog/u,
      );
      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        ALTER COLUMN "restricted_vm0_models" SET DEFAULT true
      `);

      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        DROP CONSTRAINT "org_plan_entitlements_pkey";
        ALTER TABLE "org_plan_entitlements"
        ADD CONSTRAINT "org_plan_entitlements_org_id_key" UNIQUE ("org_id")
      `);
      await expectContractFailure(dbUrl, /exact org_id primary key/u);
      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        DROP CONSTRAINT "org_plan_entitlements_org_id_key";
        ALTER TABLE "org_plan_entitlements"
        ADD CONSTRAINT "org_plan_entitlements_pkey" PRIMARY KEY ("org_id")
      `);

      await client.query(`
        ALTER FUNCTION public.ensure_legacy_org_metadata_plan_entitlement()
        SECURITY DEFINER
      `);
      await expectContractFailure(
        dbUrl,
        /accepted org metadata helper identity/u,
      );
      await client.query(`
        ALTER FUNCTION public.ensure_legacy_org_metadata_plan_entitlement()
        SECURITY INVOKER
      `);

      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        DISABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"
      `);
      await expectContractFailure(
        dbUrl,
        /accepted enabled 1023 bridge identity/u,
      );
      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        ENABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"
      `);

      await client.query(`
        CREATE VIEW "org_plan_entitlement_legacy_dependency_30757" AS
        SELECT "restricted_vm0_models"
        FROM "org_plan_entitlements"
      `);
      await expectContractFailure(
        dbUrl,
        /unexpected restriction catalog dependencies/u,
      );
      await client.query(
        `DROP VIEW "org_plan_entitlement_legacy_dependency_30757"`,
      );

      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        DISABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023";
        UPDATE "org_plan_entitlements"
        SET "restricted_vm0_models" = false
        WHERE "org_id" = 'org-plan-contract-30757-refusal';
        ALTER TABLE "org_plan_entitlements"
        ENABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"
      `);
      await expectContractFailure(dbUrl, /unequal model restriction data/u);
      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        DISABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023";
        UPDATE "org_plan_entitlements"
        SET "restricted_vm0_models" = "restricted_built_in_models"
        WHERE "org_id" = 'org-plan-contract-30757-refusal';
        ALTER TABLE "org_plan_entitlements"
        ENABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"
      `);

      await client.query(`
        ALTER TABLE "org_plan_entitlements"
        ALTER COLUMN "restricted_vm0_models" DROP NOT NULL;
        ALTER TABLE "org_plan_entitlements"
        DISABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023";
        UPDATE "org_plan_entitlements"
        SET "restricted_vm0_models" = NULL
        WHERE "org_id" = 'org-plan-contract-30757-refusal';
        ALTER TABLE "org_plan_entitlements"
        ENABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023";
        UPDATE pg_catalog.pg_attribute
        SET attnotnull = true
        WHERE attrelid = 'public.org_plan_entitlements'::regclass
          AND attname = 'restricted_vm0_models'
          AND NOT attisdropped
      `);
      await expectContractFailure(dbUrl, /NULL model restriction data/u);
      await client.query(`
        UPDATE pg_catalog.pg_attribute
        SET attnotnull = false
        WHERE attrelid = 'public.org_plan_entitlements'::regclass
          AND attname = 'restricted_vm0_models'
          AND NOT attisdropped;
        UPDATE "org_plan_entitlements"
        SET "restricted_vm0_models" = "restricted_built_in_models"
        WHERE "org_id" = 'org-plan-contract-30757-refusal';
        ALTER TABLE "org_plan_entitlements"
        ALTER COLUMN "restricted_vm0_models" SET NOT NULL
      `);

      await applyOrgPlanEntitlementRestrictionContractOnRegeneratedSchema(
        dbUrl,
        await readContractMigrationSql(),
      );
    } finally {
      await client.end();
    }
    await validatePermanentOrgPlanEntitlementRestrictionState(dbUrl);
  } finally {
    await dropDatabase(baseUrl, refusalDatabaseName);
  }
}

export async function validateOrgPlanEntitlementRestrictionContract(
  baseUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1.2: Validate org plan entitlement restriction contract ===\n",
  );
  await validateMigrationScope();
  await validateSuccessfulReplay(baseUrl);
  await validateRefusalReplay(baseUrl);
  console.log(
    "   ✅ authority-switch and canonical application SQL shapes pass",
  );
  console.log(
    "   ✅ canonical rows preserve value, ctid, xmin, and non-legacy payload",
  );
  console.log(
    "   ✅ catalog drift, dependencies, unequal rows, and NULL rows refuse transactionally\n",
  );
}
