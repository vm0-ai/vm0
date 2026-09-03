import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  bigint,
  boolean,
  getTableConfig,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";
import {
  ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION,
  validateTransitionOrgMetadataAcquisitionFirstPartySourceState,
} from "./test-org-metadata-acquisition-first-party-source-permanent";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "../../../..");
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1032_remove_chat_event_projection_metadata";
const testDatabaseName =
  "migration_org_metadata_acquisition_first_party_source_30379";
const applicationRuntimePathspecs = [
  "turbo/apps",
  "turbo/packages/api-contracts",
  "turbo/packages/core",
  "crates",
  "e2e",
] as const;

function previousReleaseOrgMetadataColumns() {
  return {
    orgId: text("org_id").primaryKey(),
    credits: bigint("credits", { mode: "number" }).notNull().default(0),
    tier: text("tier").notNull().default("limited-free-1"),
    defaultAgentId: uuid("default_agent_id"),
    onboardingPaymentPending: boolean("onboarding_payment_pending")
      .notNull()
      .default(false),
    onboardingComplete: boolean("onboarding_complete").notNull().default(false),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: varchar("subscription_status", { length: 20 }),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    pendingSubscriptionScheduleId: text("pending_subscription_schedule_id"),
    pendingSubscriptionTargetTier: text("pending_subscription_target_tier"),
    pendingSubscriptionChangeAt: timestamp("pending_subscription_change_at"),
    lastProcessedInvoiceId: text("last_processed_invoice_id"),
    acquisitionSourceType: text("acquisition_source_type"),
    acquisitionVm0Source: text("acquisition_vm0_source"),
    acquisitionCampaignId: text("acquisition_campaign_id"),
    acquisitionAdGroupId: text("acquisition_ad_group_id"),
    acquisitionCampaign: text("acquisition_campaign"),
    acquisitionUtmSource: text("acquisition_utm_source"),
    acquisitionUtmMedium: text("acquisition_utm_medium"),
    acquisitionUtmContent: text("acquisition_utm_content"),
    acquisitionUtmTerm: text("acquisition_utm_term"),
    acquisitionGclid: text("acquisition_gclid"),
    acquisitionGbraid: text("acquisition_gbraid"),
    acquisitionWbraid: text("acquisition_wbraid"),
    acquisitionGaClientId: text("acquisition_ga_client_id"),
    acquisitionLandingHost: text("acquisition_landing_host"),
    acquisitionLandingPath: text("acquisition_landing_path"),
    acquisitionReferrerDomain: text("acquisition_referrer_domain"),
    acquisitionRecordedAt: timestamp("acquisition_recorded_at"),
    autoRechargeEnabled: boolean("auto_recharge_enabled")
      .notNull()
      .default(false),
    autoRechargeThreshold: bigint("auto_recharge_threshold", {
      mode: "number",
    }),
    autoRechargeAmount: bigint("auto_recharge_amount", { mode: "number" }),
    autoRechargePendingAt: timestamp("auto_recharge_pending_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}

// Test-only previous-release shape for immediate API rollback proof.
const orgMetadataPreviousReleaseWrites = pgTable(
  "org_metadata",
  previousReleaseOrgMetadataColumns(),
);

interface HistoricalRowSnapshot {
  readonly canonical: string | null;
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

function validateApplicationCallerInventory(): void {
  assert.deepEqual(
    trackedFilesWithPattern(
      "acquisitionFirstPartySource|acquisition_first_party_source",
      applicationRuntimePathspecs,
    ),
    [
      "turbo/apps/api/src/signals/routes/__tests__/acquisition-attribution.test.ts",
      "turbo/apps/api/src/signals/routes/__tests__/billing-checkout.test.ts",
      "turbo/apps/api/src/signals/services/acquisition-attribution.service.ts",
      "turbo/apps/api/src/test-fixtures/org-metadata.ts",
    ],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "acquisitionVm0Source|acquisition_vm0_source",
      applicationRuntimePathspecs,
    ),
    [],
  );
  assert.deepEqual(
    trackedFilesWithPattern("vm0_source", applicationRuntimePathspecs),
    [
      "turbo/apps/api/src/signals/routes/__tests__/acquisition-attribution.test.ts",
      "turbo/apps/api/src/signals/routes/__tests__/billing-checkout.test.ts",
      "turbo/apps/api/src/signals/services/acquisition-attribution.service.ts",
      "turbo/apps/platform/src/__tests__/presentation-onboarding-fixture.ts",
      "turbo/apps/platform/src/signals/__tests__/signup-attribution-conversion.test.ts",
      "turbo/apps/platform/src/signals/auth-v2-page-setup.test.ts",
      "turbo/apps/platform/src/signals/auth-v2/platform-context.test.ts",
      "turbo/apps/platform/src/signals/auth.ts",
      "turbo/apps/platform/src/signals/bootstrap/ad-attribution.ts",
      "turbo/apps/platform/src/views/okou-page/__tests__/home-route.test.tsx",
      "turbo/apps/platform/src/views/okou-page/__tests__/onboarding.test.tsx",
      "turbo/apps/platform/src/views/onboarding/__tests__/onboarding-flow.test.tsx",
      "turbo/packages/api-contracts/src/contracts/acquisition-attribution.ts",
    ],
  );

  assert.deepEqual(
    trackedFilesWithPattern(
      "insert\\(orgMetadata\\)",
      applicationRuntimePathspecs,
    ),
    [],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "insert\\(orgMetadataCanonicalWrites\\)",
      applicationRuntimePathspecs,
    ),
    [
      "turbo/apps/api/src/signals/routes/__benches__/chat-threads.bench.ts",
      "turbo/apps/api/src/signals/routes/billing-credit-checkout.ts",
      "turbo/apps/api/src/signals/routes/test-billing-reconciliation-state.ts",
      "turbo/apps/api/src/signals/routes/test-cron-cleanup-sandboxes-state.ts",
      "turbo/apps/api/src/signals/routes/test-slack-state.ts",
      "turbo/apps/api/src/signals/routes/test-teams-state.ts",
      "turbo/apps/api/src/signals/routes/test-telegram-state.ts",
      "turbo/apps/api/src/signals/routes/test-usage-settlement.ts",
      "turbo/apps/api/src/signals/routes/test-usage-state.ts",
      "turbo/apps/api/src/signals/services/acquisition-attribution.service.ts",
      "turbo/apps/api/src/signals/services/billing-customer.service.ts",
      "turbo/apps/api/src/signals/services/cli-auth.service.ts",
      "turbo/apps/api/src/signals/services/credit-usage.service.ts",
      "turbo/apps/api/src/signals/services/onboarding-credit-grants.service.ts",
      "turbo/apps/api/src/signals/services/onboarding.service.ts",
      "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts",
      "turbo/apps/api/src/signals/services/webhooks-stripe.service.ts",
      "turbo/apps/api/src/test-fixtures/org-metadata.ts",
      "turbo/apps/api/src/test-fixtures/org-plan-entitlement.ts",
    ],
  );
  assert.deepEqual(
    trackedFilesWithPattern(
      "orgMetadataLegacyWrites|org-metadata-legacy-write",
      applicationRuntimePathspecs,
    ),
    [],
  );
}

async function validateCompatibilitySourceInventory(): Promise<void> {
  const serviceSource = await fs.readFile(
    path.join(
      repositoryDirectory,
      "turbo/apps/api/src/signals/services/acquisition-attribution.service.ts",
    ),
    "utf8",
  );
  assert.match(
    serviceSource,
    /\["vm0_source", "acquisitionFirstPartySource"\]/u,
  );
  assert.match(serviceSource, /insert\(orgMetadataCanonicalWrites\)/u);
  assert.match(serviceSource, /isNull\(orgMetadata\.acquisitionRecordedAt\)/u);
  assert.doesNotMatch(
    serviceSource,
    /acquisitionVm0Source|acquisition_vm0_source/u,
  );

  const contractSource = await fs.readFile(
    path.join(
      repositoryDirectory,
      "turbo/packages/api-contracts/src/contracts/acquisition-attribution.ts",
    ),
    "utf8",
  );
  assert.match(
    contractSource,
    /vm0_source: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\)/u,
  );
  assert.doesNotMatch(
    contractSource,
    /acquisitionFirstPartySource|acquisition_first_party_source/u,
  );

  const historicalBackfillSource = await fs.readFile(
    path.join(
      repositoryDirectory,
      "turbo/packages/db/scripts/migrations/011-backfill-acquisition-attribution/backfill.ts",
    ),
    "utf8",
  );
  assert.match(
    historicalBackfillSource,
    /\["vm0_source", "acquisitionVm0Source"\]/u,
  );
  assert.match(historicalBackfillSource, /"acquisition_vm0_source"/u);
  assert.doesNotMatch(
    historicalBackfillSource,
    /acquisitionFirstPartySource|acquisition_first_party_source/u,
  );
}

function validateApplicationWriteProjections(): void {
  const currentColumns = getTableConfig(orgMetadata).columns.map((column) => {
    return column.name;
  });
  assert.ok(currentColumns.includes("acquisition_first_party_source"));
  assert.equal(currentColumns.includes("acquisition_vm0_source"), false);

  const canonicalWriteColumns = getTableConfig(
    orgMetadataCanonicalWrites,
  ).columns.map((column) => {
    return column.name;
  });
  assert.ok(canonicalWriteColumns.includes("acquisition_first_party_source"));
  assert.equal(canonicalWriteColumns.includes("acquisition_vm0_source"), false);

  const previousReleaseWriteColumns = getTableConfig(
    orgMetadataPreviousReleaseWrites,
  ).columns.map((column) => {
    return column.name;
  });
  assert.ok(previousReleaseWriteColumns.includes("acquisition_vm0_source"));
  assert.equal(
    previousReleaseWriteColumns.includes("acquisition_first_party_source"),
    false,
  );
}

async function validateApplicationStatementInventory(): Promise<void> {
  validateApplicationCallerInventory();
  await validateCompatibilitySourceInventory();
  validateApplicationWriteProjections();
}

async function readMigrationStatements(): Promise<readonly string[]> {
  const migrationSql = await fs.readFile(
    path.join(
      migrationsDirectory,
      `${ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION}.sql`,
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
  assert.equal(statements.length, 5);
  assert.match(statements[0] ?? "", /^DO \$\$/u);
  assert.equal(
    statements[1],
    'ALTER TABLE "org_metadata" ADD COLUMN "acquisition_first_party_source" text;',
  );
  assert.match(
    statements[2] ?? "",
    /CREATE FUNCTION public\.sync_org_metadata_acquisition_first_party_source_1033\(\)/u,
  );
  assert.match(
    statements[3] ?? "",
    /^CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033/u,
  );
  assert.match(statements[4] ?? "", /^DO \$\$/u);
  for (const statement of statements) {
    assert.doesNotMatch(statement, /^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  }
  assert.doesNotMatch(
    migrationSql,
    /(?:UPDATE|DELETE FROM|INSERT INTO|TRUNCATE)\s+"?org_metadata"?/iu,
  );
  return statements;
}

async function expectPreflightRejection(
  client: Client,
  preflightStatement: string,
  mutation: string,
  message: RegExp,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(mutation);
    await assert.rejects(client.query(preflightStatement), message);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function validateFailClosedPreflight(
  client: Client,
  preflightStatement: string,
): Promise<void> {
  await expectPreflightRejection(
    client,
    preflightStatement,
    `ALTER TABLE "org_metadata" ADD COLUMN "acquisition_first_party_source" text`,
    /unexpected canonical column/u,
  );
  await expectPreflightRejection(
    client,
    preflightStatement,
    `ALTER TABLE "org_metadata" ALTER COLUMN "acquisition_vm0_source" TYPE varchar(100)`,
    /accepted nullable no-default legacy text column/u,
  );
  await expectPreflightRejection(
    client,
    preflightStatement,
    `ALTER TABLE "org_metadata" ALTER COLUMN "acquisition_vm0_source" SET NOT NULL`,
    /accepted nullable no-default legacy text column/u,
  );
  await expectPreflightRejection(
    client,
    preflightStatement,
    `ALTER TABLE "org_metadata" ALTER COLUMN "acquisition_vm0_source" SET DEFAULT 'homepage'`,
    /accepted nullable no-default legacy text column/u,
  );
  await expectPreflightRejection(
    client,
    preflightStatement,
    `
      CREATE FUNCTION public.sync_org_metadata_acquisition_first_party_source_1033()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        RETURN NEW;
      END;
      $body$
    `,
    /unexpected issue-owned bridge identity/u,
  );
  await expectPreflightRejection(
    client,
    preflightStatement,
    `
      CREATE FUNCTION public.unexpected_acquisition_bridge_30379()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        RETURN NEW;
      END;
      $body$;
      CREATE TRIGGER sync_org_metadata_acquisition_first_party_source_1033
      BEFORE INSERT ON "org_metadata"
      FOR EACH ROW
      EXECUTE FUNCTION public.unexpected_acquisition_bridge_30379()
    `,
    /unexpected issue-owned bridge identity/u,
  );
}

async function readHistoricalRows(
  client: Client,
  orgIds: readonly string[],
  expanded: boolean,
): Promise<readonly HistoricalRowSnapshot[]> {
  const canonicalSelection = expanded
    ? '"row"."acquisition_first_party_source"'
    : "NULL::text";
  const canonicalRemoval = expanded
    ? "to_jsonb(\"row\") - 'acquisition_first_party_source'"
    : 'to_jsonb("row")';
  const result = await client.query<HistoricalRowSnapshot>(
    `
      SELECT
        "row"."org_id" AS "orgId",
        "row"."ctid"::text AS "ctid",
        "row"."xmin"::text AS "xmin",
        ${canonicalSelection} AS "canonical",
        ${canonicalRemoval} AS "rest"
      FROM "org_metadata" AS "row"
      WHERE "row"."org_id" = ANY($1::text[])
      ORDER BY "row"."org_id"
    `,
    [[...orgIds]],
  );
  return result.rows;
}

async function executePreviousReleaseWrites(
  database: NodePgDatabase<Record<string, never>>,
  insertOrgId: string,
  updateOrgId: string,
  recordedAt: Date,
): Promise<void> {
  const [inserted] = await database
    .insert(orgMetadataPreviousReleaseWrites)
    .values({
      orgId: insertOrgId,
      credits: 0,
      acquisitionVm0Source: "homepage",
      acquisitionRecordedAt: recordedAt,
      updatedAt: recordedAt,
    })
    .onConflictDoNothing({ target: orgMetadataPreviousReleaseWrites.orgId })
    .returning({ orgId: orgMetadataPreviousReleaseWrites.orgId });
  assert.equal(inserted?.orgId, insertOrgId);

  const [conflictInsert] = await database
    .insert(orgMetadataPreviousReleaseWrites)
    .values({
      orgId: insertOrgId,
      credits: 0,
      acquisitionVm0Source: "marketing",
      acquisitionRecordedAt: new Date("2031-01-02T03:04:05.000Z"),
    })
    .onConflictDoNothing({ target: orgMetadataPreviousReleaseWrites.orgId })
    .returning({ orgId: orgMetadataPreviousReleaseWrites.orgId });
  assert.equal(conflictInsert, undefined);

  await database
    .insert(orgMetadataPreviousReleaseWrites)
    .values({ orgId: updateOrgId, credits: 0 })
    .onConflictDoNothing({ target: orgMetadataPreviousReleaseWrites.orgId });
  const [updated] = await database
    .update(orgMetadataPreviousReleaseWrites)
    .set({
      acquisitionVm0Source: "presentation",
      acquisitionRecordedAt: recordedAt,
      updatedAt: recordedAt,
    })
    .where(
      and(
        eq(orgMetadataPreviousReleaseWrites.orgId, updateOrgId),
        isNull(orgMetadataPreviousReleaseWrites.acquisitionRecordedAt),
      ),
    )
    .returning({ orgId: orgMetadataPreviousReleaseWrites.orgId });
  assert.equal(updated?.orgId, updateOrgId);

  const [blockedOverwrite] = await database
    .update(orgMetadataPreviousReleaseWrites)
    .set({
      acquisitionVm0Source: "marketing",
      acquisitionRecordedAt: new Date("2031-01-02T03:04:05.000Z"),
    })
    .where(
      and(
        eq(orgMetadataPreviousReleaseWrites.orgId, updateOrgId),
        isNull(orgMetadataPreviousReleaseWrites.acquisitionRecordedAt),
      ),
    )
    .returning({ orgId: orgMetadataPreviousReleaseWrites.orgId });
  assert.equal(blockedOverwrite, undefined);
}

async function verifyPreviousReleaseReads(
  client: Client,
  database: NodePgDatabase<Record<string, never>>,
  insertOrgId: string,
  updateOrgId: string,
  expanded: boolean,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        acquisitionVm0Source:
          orgMetadataPreviousReleaseWrites.acquisitionVm0Source,
        orgId: orgMetadataPreviousReleaseWrites.orgId,
      })
      .from(orgMetadataPreviousReleaseWrites)
      .where(eq(orgMetadataPreviousReleaseWrites.orgId, updateOrgId))
      .limit(1)
      .for("update");
    assert.deepEqual(locked, {
      acquisitionVm0Source: "presentation",
      orgId: updateOrgId,
    });
  });

  const canonicalSelection = expanded
    ? '"acquisition_first_party_source" AS "canonical"'
    : 'NULL::text AS "canonical"';
  const rows = await client.query<{
    canonical: string | null;
    legacy: string | null;
    orgId: string;
  }>(
    `
      SELECT
        "org_id" AS "orgId",
        "acquisition_vm0_source" AS "legacy",
        ${canonicalSelection}
      FROM "org_metadata"
      WHERE "org_id" = ANY($1::text[])
      ORDER BY "org_id"
    `,
    [[insertOrgId, updateOrgId]],
  );
  assert.deepEqual(rows.rows, [
    {
      canonical: expanded ? "homepage" : null,
      legacy: "homepage",
      orgId: insertOrgId,
    },
    {
      canonical: expanded ? "presentation" : null,
      legacy: "presentation",
      orgId: updateOrgId,
    },
  ]);
}

async function exercisePreviousReleaseApplicationStatements(
  client: Client,
  database: NodePgDatabase<Record<string, never>>,
  prefix: string,
  expanded: boolean,
): Promise<readonly string[]> {
  const insertOrgId = `${prefix}-insert`;
  const updateOrgId = `${prefix}-update`;
  await executePreviousReleaseWrites(
    database,
    insertOrgId,
    updateOrgId,
    new Date("2030-01-02T03:04:05.000Z"),
  );
  await verifyPreviousReleaseReads(
    client,
    database,
    insertOrgId,
    updateOrgId,
    expanded,
  );

  return [insertOrgId, updateOrgId];
}

async function executeCurrentApplicationWrites(
  database: NodePgDatabase<Record<string, never>>,
  insertOrgId: string,
  unattributedOrgId: string,
  updateOrgId: string,
  recordedAt: Date,
): Promise<void> {
  const [inserted] = await database
    .insert(orgMetadataCanonicalWrites)
    .values({
      orgId: insertOrgId,
      credits: 0,
      acquisitionFirstPartySource: "homepage",
      acquisitionRecordedAt: recordedAt,
      updatedAt: recordedAt,
    })
    .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
    .returning({ orgId: orgMetadataCanonicalWrites.orgId });
  assert.equal(inserted?.orgId, insertOrgId);

  const [conflictInsert] = await database
    .insert(orgMetadataCanonicalWrites)
    .values({
      orgId: insertOrgId,
      credits: 0,
      acquisitionFirstPartySource: "marketing",
      acquisitionRecordedAt: new Date("2033-01-02T03:04:05.000Z"),
    })
    .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
    .returning({ orgId: orgMetadataCanonicalWrites.orgId });
  assert.equal(conflictInsert, undefined);

  await database
    .insert(orgMetadataCanonicalWrites)
    .values({ orgId: unattributedOrgId, credits: 0 })
    .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId });
  await database
    .insert(orgMetadataCanonicalWrites)
    .values({ orgId: updateOrgId, credits: 0 })
    .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId });

  const [updated] = await database
    .update(orgMetadata)
    .set({
      acquisitionFirstPartySource: "presentation",
      acquisitionRecordedAt: recordedAt,
      updatedAt: recordedAt,
    })
    .where(
      and(
        eq(orgMetadata.orgId, updateOrgId),
        isNull(orgMetadata.acquisitionRecordedAt),
      ),
    )
    .returning({ orgId: orgMetadata.orgId });
  assert.equal(updated?.orgId, updateOrgId);

  const [blockedOverwrite] = await database
    .update(orgMetadata)
    .set({
      acquisitionFirstPartySource: "marketing",
      acquisitionRecordedAt: new Date("2033-01-02T03:04:05.000Z"),
    })
    .where(
      and(
        eq(orgMetadata.orgId, updateOrgId),
        isNull(orgMetadata.acquisitionRecordedAt),
      ),
    )
    .returning({ orgId: orgMetadata.orgId });
  assert.equal(blockedOverwrite, undefined);
}

async function verifyCurrentApplicationReads(
  client: Client,
  database: NodePgDatabase<Record<string, never>>,
  insertOrgId: string,
  unattributedOrgId: string,
  updateOrgId: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        acquisitionFirstPartySource: orgMetadata.acquisitionFirstPartySource,
        orgId: orgMetadata.orgId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, updateOrgId))
      .limit(1)
      .for("update");
    assert.deepEqual(locked, {
      acquisitionFirstPartySource: "presentation",
      orgId: updateOrgId,
    });
  });

  const rows = await client.query<{
    canonical: string | null;
    legacy: string | null;
    orgId: string;
  }>(
    `
      SELECT
        "org_id" AS "orgId",
        "acquisition_vm0_source" AS "legacy",
        "acquisition_first_party_source" AS "canonical"
      FROM "org_metadata"
      WHERE "org_id" = ANY($1::text[])
      ORDER BY "org_id"
    `,
    [[insertOrgId, unattributedOrgId, updateOrgId]],
  );
  assert.deepEqual(rows.rows, [
    {
      canonical: "homepage",
      legacy: "homepage",
      orgId: insertOrgId,
    },
    {
      canonical: null,
      legacy: null,
      orgId: unattributedOrgId,
    },
    {
      canonical: "presentation",
      legacy: "presentation",
      orgId: updateOrgId,
    },
  ]);
}

async function exerciseCurrentApplicationStatements(
  client: Client,
  database: NodePgDatabase<Record<string, never>>,
  prefix: string,
): Promise<readonly string[]> {
  const insertOrgId = `${prefix}-insert`;
  const unattributedOrgId = `${prefix}-unattributed`;
  const updateOrgId = `${prefix}-update`;
  await executeCurrentApplicationWrites(
    database,
    insertOrgId,
    unattributedOrgId,
    updateOrgId,
    new Date("2032-01-02T03:04:05.000Z"),
  );
  await verifyCurrentApplicationReads(
    client,
    database,
    insertOrgId,
    unattributedOrgId,
    updateOrgId,
  );

  return [insertOrgId, unattributedOrgId, updateOrgId];
}

async function exerciseExpandedDatabase(
  client: Client,
  preflightStatement: string,
): Promise<void> {
  await applyMigrationsFromDirectoryUpToTag(
    client,
    migrationsDirectory,
    previousMigration,
  );
  await validateFailClosedPreflight(client, preflightStatement);

  const database = drizzle(client);
  const historicalLegacyOrgId =
    "org-metadata-acquisition-30379-historical-legacy";
  const historicalNullOrgId = "org-metadata-acquisition-30379-historical-null";
  await client.query(
    `
          INSERT INTO "org_metadata" (
            "org_id", "credits", "acquisition_vm0_source"
          ) VALUES ($1, 0, 'calendar'), ($2, 0, NULL)
        `,
    [historicalLegacyOrgId, historicalNullOrgId],
  );
  const preExpandApplicationOrgIds =
    await exercisePreviousReleaseApplicationStatements(
      client,
      database,
      "org-metadata-acquisition-30379-app-before-expand",
      false,
    );
  const historicalOrgIds = [
    historicalLegacyOrgId,
    historicalNullOrgId,
    ...preExpandApplicationOrgIds,
  ].sort();
  const before = await readHistoricalRows(client, historicalOrgIds, false);
  const beforeCount = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM "org_metadata"`,
  );

  await applyMigrationsFromDirectoryUpToTag(
    client,
    migrationsDirectory,
    ORG_METADATA_ACQUISITION_FIRST_PARTY_SOURCE_MIGRATION,
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
    historicalOrgIds.map(() => {
      return null;
    }),
  );
  const afterCount = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS "count" FROM "org_metadata"`,
  );
  assert.deepEqual(afterCount.rows, beforeCount.rows);

  await exerciseCurrentApplicationStatements(
    client,
    database,
    "org-metadata-acquisition-30379-app-after-expand",
  );
  await exercisePreviousReleaseApplicationStatements(
    client,
    database,
    "org-metadata-acquisition-30605-rollback-after-switch",
    true,
  );
  console.log(
    "   ✅ previous-release SQL runs before expansion and after the switch",
  );
  console.log(
    "   ✅ canonical-only writes/read locks mirror and both-null inserts remain valid",
  );
  console.log(
    "   ✅ historical rows retain ctid, xmin, values, and legacy-only state",
  );
  console.log(
    "   ✅ migration preflight rejects canonical, legacy-shape, and bridge drift\n",
  );
}

export async function validateOrgMetadataAcquisitionFirstPartySourceExpansion(
  baseDbUrl: string,
): Promise<void> {
  console.log(
    "=== Validate org metadata acquisition first-party source expansion ===\n",
  );
  await validateApplicationStatementInventory();
  const migrationStatements = await readMigrationStatements();

  const dbUrl = await createDatabase(baseDbUrl);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await exerciseExpandedDatabase(client, migrationStatements[0] ?? "");
    } finally {
      await client.end();
    }

    await validateTransitionOrgMetadataAcquisitionFirstPartySourceState(dbUrl);
  } finally {
    await dropDatabase(baseDbUrl);
  }
}
