import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

import { loadOrgPlanCapabilities } from "../../../apps/api/src/signals/services/org-plan-entitlement-read.service";
import { upsertOrgPlanEntitlement } from "../../../apps/api/src/signals/services/org-plan-entitlements.service";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION,
  validatePermanentOrgPlanEntitlementRestrictionState,
} from "./test-org-plan-entitlement-restriction-permanent";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "../../../..");
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1022_workflow_physical_switch";
const testDatabaseName = "migration_org_plan_restriction_expand_30162";
const applicationRuntimePathspecs = [
  "turbo/apps",
  "turbo/packages/api-contracts",
  "turbo/packages/core",
  "crates",
  "e2e",
] as const;
const orgPlanEntitlementsPreviousReleaseWrites = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementLegacyColumns(),
);

interface HistoricalRowSnapshot {
  readonly canonical: boolean | null;
  readonly ctid: string;
  readonly orgId: string;
  readonly rest: Record<string, unknown>;
  readonly xmin: string;
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

function trackedFilesWithPattern(
  pattern: string,
  pathspecs: readonly string[],
): readonly string[] {
  const result = spawnSync(
    "git",
    ["grep", "-l", "-E", pattern, "--", ...pathspecs],
    {
      cwd: repositoryDirectory,
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `git grep exited with ${String(result.status)}`,
  );
  return result.stdout
    .split("\n")
    .map((filePath) => {
      return filePath.trim();
    })
    .filter((filePath) => {
      return filePath.length > 0;
    })
    .sort();
}

function validateExactApplicationCallers(): readonly string[] {
  const applicationFiles = trackedFilesWithPattern("orgPlanEntitlements", [
    "turbo/apps",
  ]);
  assert.deepEqual(applicationFiles, [
    "turbo/apps/api/src/signals/routes/test-billing-reconciliation-state.ts",
    "turbo/apps/api/src/signals/routes/test-usage-settlement.ts",
    "turbo/apps/api/src/signals/services/billing-checkout.service.ts",
    "turbo/apps/api/src/signals/services/billing-concurrency-subscription.service.ts",
    "turbo/apps/api/src/signals/services/credit-recharge.service.ts",
    "turbo/apps/api/src/signals/services/org-billing-period.service.ts",
    "turbo/apps/api/src/signals/services/org-concurrency-entitlements.service.ts",
    "turbo/apps/api/src/signals/services/org-deletion-billing.service.ts",
    "turbo/apps/api/src/signals/services/org-plan-entitlement-read.service.ts",
    "turbo/apps/api/src/signals/services/org-plan-entitlements.service.ts",
    "turbo/apps/api/src/signals/services/webhooks-stripe.service.ts",
    "turbo/apps/api/src/test-fixtures/org-plan-entitlement.ts",
  ]);
  assert.deepEqual(
    trackedFilesWithPattern(
      "insert\\(orgPlanEntitlementsCanonicalWrites\\)",
      applicationRuntimePathspecs,
    ),
    [
      "turbo/apps/api/src/signals/routes/test-usage-settlement.ts",
      "turbo/apps/api/src/signals/services/org-plan-entitlements.service.ts",
      "turbo/apps/api/src/test-fixtures/org-plan-entitlement.ts",
    ],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "orgPlanEntitlementsLegacyWrites|org-plan-entitlement-legacy-write",
      applicationRuntimePathspecs,
    ),
    [],
  );

  assert.deepEqual(
    trackedFilesWithPattern(
      "restrictedBuiltInModels|restricted_built_in_models",
      applicationRuntimePathspecs,
    ),
    [
      "turbo/apps/api/src/signals/routes/test-usage-settlement.ts",
      "turbo/apps/api/src/signals/services/org-plan-entitlement-read.service.ts",
      "turbo/apps/api/src/signals/services/org-plan-entitlement-tier-values.ts",
      "turbo/apps/api/src/signals/services/org-plan-entitlements.service.ts",
      "turbo/apps/api/src/test-fixtures/org-plan-entitlement.ts",
    ],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "orgPlanEntitlements\\.restrictedBuiltInModels",
      applicationRuntimePathspecs,
    ),
    [
      "turbo/apps/api/src/signals/services/org-plan-entitlement-read.service.ts",
      "turbo/apps/api/src/test-fixtures/org-plan-entitlement.ts",
    ],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "orgPlanEntitlements\\.restrictedVm0Models|restricted_vm0_models",
      applicationRuntimePathspecs,
    ),
    [],
  );

  return applicationFiles;
}

function validateApplicationWriteProjections(): void {
  const currentColumnNames = getTableConfig(orgPlanEntitlements).columns.map(
    (column) => {
      return column.name;
    },
  );
  assert.ok(currentColumnNames.includes("restricted_vm0_models"));
  assert.ok(currentColumnNames.includes("restricted_built_in_models"));

  const canonicalWriteColumnNames = getTableConfig(
    orgPlanEntitlementsCanonicalWrites,
  ).columns.map((column) => {
    return column.name;
  });
  assert.ok(canonicalWriteColumnNames.includes("restricted_built_in_models"));
  assert.equal(
    canonicalWriteColumnNames.includes("restricted_vm0_models"),
    false,
  );

  const previousReleaseWriteColumnNames = getTableConfig(
    orgPlanEntitlementsPreviousReleaseWrites,
  ).columns.map((column) => {
    return column.name;
  });
  assert.ok(previousReleaseWriteColumnNames.includes("restricted_vm0_models"));
  assert.equal(
    previousReleaseWriteColumnNames.includes("restricted_built_in_models"),
    false,
  );
}

async function validateApplicationStatementHazards(
  applicationFiles: readonly string[],
): Promise<void> {
  const hazards = [
    /\.select\(\s*\)\s*\.from\(orgPlanEntitlements\)/u,
    /\.select\(\s*orgPlanEntitlements\s*\)/u,
    /[,{]\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*orgPlanEntitlements\s*[,}]/u,
    /\.\.\.\s*orgPlanEntitlements/u,
    /getTableColumns\(\s*orgPlanEntitlements\s*\)/u,
    /\.insert\(\s*orgPlanEntitlements\s*\)/u,
    /\.returning\(\s*orgPlanEntitlements\s*\)/u,
    /query\.orgPlanEntitlements\.(?:findFirst|findMany)/u,
    /(?:insert|update|delete)\(orgPlanEntitlements\)(?:(?!;)[\s\S])*?\.returning\(\s*\)/u,
  ] as const;
  for (const filePath of applicationFiles) {
    const source = await fs.readFile(
      path.join(repositoryDirectory, filePath),
      "utf8",
    );
    for (const hazard of hazards) {
      assert.doesNotMatch(source, hazard, filePath);
    }
  }
}

async function validateCanonicalReaderSource(): Promise<void> {
  const readerSource = await fs.readFile(
    path.join(
      repositoryDirectory,
      "turbo/apps/api/src/signals/services/org-plan-entitlement-read.service.ts",
    ),
    "utf8",
  );
  assert.match(
    readerSource,
    /restrictedBuiltInModels:\s*orgPlanEntitlements\.restrictedBuiltInModels/u,
  );
  assert.match(
    readerSource,
    /Unexpected NULL restricted_built_in_models for org plan entitlement/u,
  );
  assert.doesNotMatch(readerSource, /coalesce/iu);
  assert.doesNotMatch(
    readerSource,
    /orgPlanEntitlements\.restrictedVm0Models/u,
  );
}

async function validateApplicationStatementInventory(): Promise<void> {
  const applicationFiles = validateExactApplicationCallers();
  validateApplicationWriteProjections();
  await validateApplicationStatementHazards(applicationFiles);
  await validateCanonicalReaderSource();
}

async function validateMigrationStatementScope(): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION}.sql`,
    ),
    "utf8",
  );
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter((statement) => {
      return statement.length > 0;
    });
  assert.equal(statements.length, 4);
  assert.deepEqual(
    statements.map((statement) => {
      const firstLine = statement.split("\n", 1)[0];
      return firstLine?.replace(/^--[^\n]*\n/u, "") ?? "";
    }),
    [
      'ALTER TABLE "org_plan_entitlements" ADD COLUMN "restricted_built_in_models" boolean;',
      "-- Temporary #30162 expand/mirror bridge. Keep it through the later canonical",
      "CREATE TRIGGER sync_org_plan_entitlement_model_restrictions_1023",
      "CREATE OR REPLACE FUNCTION public.ensure_legacy_org_metadata_plan_entitlement()",
    ],
  );
  for (const statement of statements) {
    assert.doesNotMatch(statement, /^(?:INSERT|UPDATE|DELETE)\b/iu);
  }
}

async function readHistoricalRows(
  client: Client,
  orgIds: readonly string[],
  expanded: boolean,
): Promise<readonly HistoricalRowSnapshot[]> {
  const canonicalSelection = expanded
    ? '"row"."restricted_built_in_models"'
    : "NULL::boolean";
  const canonicalRemoval = expanded
    ? "to_jsonb(\"row\") - 'restricted_built_in_models'"
    : 'to_jsonb("row")';
  const result = await client.query<HistoricalRowSnapshot>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        ${canonicalSelection} AS "canonical",
        ${canonicalRemoval} AS "rest"
      FROM "org_plan_entitlements" AS "row"
      WHERE "row"."org_id" = ANY($1::text[])
      ORDER BY "row"."org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

export async function exercisePreviousReleaseApplicationStatements(
  database: NodePgDatabase<Record<string, never>>,
  orgId: string,
): Promise<void> {
  await database
    .insert(orgPlanEntitlementsPreviousReleaseWrites)
    .values({
      orgId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedVm0Models: false,
    })
    .onConflictDoUpdate({
      target: orgPlanEntitlementsPreviousReleaseWrites.orgId,
      set: { restrictedVm0Models: false },
    });
  const [inserted] = await database
    .select({
      restrictedVm0Models:
        orgPlanEntitlementsPreviousReleaseWrites.restrictedVm0Models,
    })
    .from(orgPlanEntitlementsPreviousReleaseWrites)
    .where(eq(orgPlanEntitlementsPreviousReleaseWrites.orgId, orgId))
    .limit(1);
  assert.equal(inserted?.restrictedVm0Models, false);

  await database
    .insert(orgPlanEntitlementsPreviousReleaseWrites)
    .values({
      orgId,
      planKey: "fixture",
      planRank: 0,
      source: "test_fixture",
      restrictedVm0Models: true,
    })
    .onConflictDoUpdate({
      target: orgPlanEntitlementsPreviousReleaseWrites.orgId,
      set: { restrictedVm0Models: true },
    });
  await database
    .update(orgPlanEntitlementsPreviousReleaseWrites)
    .set({ restrictedVm0Models: false })
    .where(eq(orgPlanEntitlementsPreviousReleaseWrites.orgId, orgId));

  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        restrictedVm0Models:
          orgPlanEntitlementsPreviousReleaseWrites.restrictedVm0Models,
      })
      .from(orgPlanEntitlementsPreviousReleaseWrites)
      .where(eq(orgPlanEntitlementsPreviousReleaseWrites.orgId, orgId))
      .limit(1)
      .for("update");
    assert.equal(locked?.restrictedVm0Models, false);
  });
}

export async function exerciseCurrentApplicationStatements(
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

  const [selection] = await database
    .select({
      orgId: orgPlanEntitlements.orgId,
      planKey: orgPlanEntitlements.planKey,
      status: orgPlanEntitlements.status,
      source: orgPlanEntitlements.source,
      sourceMetadata: orgPlanEntitlements.sourceMetadata,
      stripeSubscriptionId: orgPlanEntitlements.stripeSubscriptionId,
      stripePriceId: orgPlanEntitlements.stripePriceId,
      currentPeriodStart: orgPlanEntitlements.currentPeriodStart,
      currentPeriodEnd: orgPlanEntitlements.currentPeriodEnd,
      expiresAt: orgPlanEntitlements.expiresAt,
      autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
      restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  assert.equal(selection?.orgId, orgId);
  assert.equal(selection?.restrictedBuiltInModels, false);

  const [freePair] = await database
    .select({
      canonical: orgPlanEntitlements.restrictedBuiltInModels,
      legacy: orgPlanEntitlements.restrictedVm0Models,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  assert.deepEqual(freePair, { canonical: false, legacy: false });

  await database.transaction(async (tx) => {
    await upsertOrgPlanEntitlement(tx, {
      orgId,
      source: "org_metadata_bootstrap",
      tier: "pro-suspend",
    });
  });
  const suspended = await loadOrgPlanCapabilities(database, orgId);
  assert.equal(suspended?.restrictedVm0Models, true);
  const [suspendedPair] = await database
    .select({
      canonical: orgPlanEntitlements.restrictedBuiltInModels,
      legacy: orgPlanEntitlements.restrictedVm0Models,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  assert.deepEqual(suspendedPair, { canonical: true, legacy: true });

  await database
    .update(orgPlanEntitlements)
    .set({ status: "manual_active" })
    .where(eq(orgPlanEntitlements.orgId, orgId));

  const deleteOrgId = `${orgId}-delete`;
  await database.insert(orgPlanEntitlementsCanonicalWrites).values({
    orgId: deleteOrgId,
    planKey: "fixture",
    planRank: 0,
    source: "test_fixture",
    restrictedBuiltInModels: false,
  });
  await database
    .delete(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, deleteOrgId));
  const [deleted] = await database
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, deleteOrgId));
  assert.equal(deleted, undefined);
}

async function validateCanonicalNullFailsClosed(
  client: Client,
  database: NodePgDatabase<Record<string, never>>,
  orgId: string,
): Promise<void> {
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
    `ALTER TABLE "org_plan_entitlements" DISABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"`,
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
      `ALTER TABLE "org_plan_entitlements" ENABLE TRIGGER "sync_org_plan_entitlement_model_restrictions_1023"`,
    );
  }

  await assert.rejects(loadOrgPlanCapabilities(database, orgId), {
    message: `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
  });

  await client.query(
    `
      UPDATE "org_plan_entitlements"
      SET "restricted_vm0_models" = false
      WHERE "org_id" = $1
    `,
    [orgId],
  );
  const repaired = await loadOrgPlanCapabilities(database, orgId);
  assert.equal(repaired?.restrictedVm0Models, false);
}

export async function validateOrgPlanEntitlementRestrictionExpansion(
  baseDbUrl: string,
): Promise<void> {
  console.log("=== Validate org plan entitlement restriction expansion ===\n");
  await validateApplicationStatementInventory();
  await validateMigrationStatementScope();

  const dbUrl = await createDatabase(baseDbUrl);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        previousMigration,
      );

      const database = drizzle(client);
      const historicalOrgId = "org-plan-restriction-30162-historical";
      const helperOrgId = "org-plan-restriction-30162-helper-before-expand";
      const previousReleaseOrgId =
        "org-plan-restriction-30162-previous-release-before-expand";
      await client.query(
        `
        INSERT INTO "org_plan_entitlements" (
          "org_id", "plan_key", "plan_rank", "source",
          "restricted_vm0_models"
        ) VALUES ($1, 'fixture', 0, 'test_fixture', false)
      `,
        [historicalOrgId],
      );
      await client.query(
        `INSERT INTO "org_metadata" ("org_id", "tier", "credits") VALUES ($1, 'team', 0)`,
        [helperOrgId],
      );
      await exercisePreviousReleaseApplicationStatements(
        database,
        previousReleaseOrgId,
      );

      const historicalOrgIds = [
        previousReleaseOrgId,
        helperOrgId,
        historicalOrgId,
      ].sort();
      const before = await readHistoricalRows(client, historicalOrgIds, false);
      assert.equal(before.length, historicalOrgIds.length);
      const beforeCount = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS "count" FROM "org_plan_entitlements"`,
      );

      await applyMigrationsFromDirectoryUpToTag(
        client,
        migrationsDirectory,
        ORG_PLAN_ENTITLEMENT_RESTRICTION_MIGRATION,
      );

      const after = await readHistoricalRows(client, historicalOrgIds, true);
      assert.deepEqual(
        after.map(({ canonical: _, ...row }) => {
          return row;
        }),
        before.map(({ canonical: _, ...row }) => {
          return row;
        }),
      );
      assert.deepEqual(
        after.map((row) => {
          return row.canonical;
        }),
        [null, null, null],
      );
      const afterCount = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS "count" FROM "org_plan_entitlements"`,
      );
      assert.deepEqual(afterCount.rows, beforeCount.rows);

      const rollbackOrgId =
        "org-plan-restriction-30207-previous-release-after-expand";
      await exercisePreviousReleaseApplicationStatements(
        database,
        rollbackOrgId,
      );
      const rollbackRows = await readHistoricalRows(
        client,
        [rollbackOrgId],
        true,
      );
      assert.deepEqual(rollbackRows[0]?.canonical, false);
      assert.equal(
        Reflect.get(rollbackRows[0]?.rest ?? {}, "restricted_vm0_models"),
        false,
      );

      const postExpandAppOrgId =
        "org-plan-restriction-30162-current-app-after-expand";
      await exerciseCurrentApplicationStatements(database, postExpandAppOrgId);
      const postExpand = await client.query<{
        canonical: boolean;
        legacy: boolean;
      }>(
        `
        SELECT
          "restricted_vm0_models" AS "legacy",
          "restricted_built_in_models" AS "canonical"
        FROM "org_plan_entitlements"
        WHERE "org_id" = $1
      `,
        [postExpandAppOrgId],
      );
      assert.deepEqual(postExpand.rows, [{ canonical: true, legacy: true }]);

      await validateCanonicalNullFailsClosed(
        client,
        database,
        "org-plan-restriction-30207-null-canonical",
      );

      console.log("   ✅ previous-release SQL runs before and after expansion");
      console.log(
        "   ✅ historical rows retain ctid, xmin, and legacy-only state",
      );
      console.log(
        "   ✅ canonical writes/read locks mirror and NULL reads fail closed\n",
      );
    } finally {
      await client.end();
    }

    await validatePermanentOrgPlanEntitlementRestrictionState(
      dbUrl,
      "nullable",
    );
  } finally {
    await dropDatabase(baseDbUrl);
  }
}
