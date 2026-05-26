#!/usr/bin/env tsx

/**
 * Find and clean up orphaned org data.
 *
 * Compares all org IDs in the database against Clerk's organization list.
 * Any org ID that exists in DB tables but NOT in Clerk is considered orphaned
 * (the org was deleted in Clerk but local data was never cleaned up).
 *
 * Uses the same three-phase cleanup as the organization.deleted webhook:
 *   Phase 1: External services (Stripe, Telegram, Connectors, Slack)
 *   Phase 2: S3 storage objects
 *   Phase 3: Database records
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/006-cleanup-orphaned-orgs/cleanup.ts
 *   pnpm exec tsx scripts/migrations/006-cleanup-orphaned-orgs/cleanup.ts --migrate
 *   pnpm exec tsx scripts/migrations/006-cleanup-orphaned-orgs/cleanup.ts --migrate --org-id=org_xxx
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required
 */

import { parseArgs } from "node:util";
import { createClerkClient } from "@clerk/backend";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Clerk client
// ---------------------------------------------------------------------------

type ClerkClient = {
  organizations: {
    getOrganizationList: (params: {
      limit: number;
      offset: number;
    }) => Promise<{ data: Array<{ id: string }>; totalCount: number }>;
  };
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    "org-id": { type: "string" },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;
const SINGLE_ORG_ID = args["org-id"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THROTTLE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

interface OrgDataSummary {
  orgId: string;
  tables: Record<string, number>;
  totalRows: number;
}

// All tables with an org_id column that we need to check
const ORG_TABLES = [
  "agent_composes",
  "agent_runs",
  "storages",
  "secrets",
  "model_providers",
  "connectors",
  "variables",
  "usage_daily",
  "export_jobs",
  "zero_agents",
  "zero_agent_schedules",
  "slack_org_installations",
  "org_members_cache",
  "org_members_metadata",
  "org_cache",
  "org_metadata",
] as const;

// Org IDs that are not real Clerk organizations — must never be deleted
const SYSTEM_ORG_IDS = new Set(["__system__"]);

// ---------------------------------------------------------------------------
// Phase 1: Discover all org IDs in the database
// ---------------------------------------------------------------------------

async function getAllDbOrgIds(
  db: ReturnType<typeof drizzle>,
): Promise<Set<string>> {
  const orgIds = new Set<string>();

  for (const table of ORG_TABLES) {
    const rows = await db.execute<{ org_id: string }>(
      sql.raw(`SELECT DISTINCT org_id FROM ${table} WHERE org_id IS NOT NULL`),
    );
    for (const row of rows) {
      orgIds.add(row.org_id);
    }
  }

  return orgIds;
}

// ---------------------------------------------------------------------------
// Phase 2: Get all org IDs from Clerk
// ---------------------------------------------------------------------------

async function getAllClerkOrgIds(clerk: ClerkClient): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let offset = 0;
  const limit = 100;

  for (;;) {
    const { data, totalCount } = await clerk.organizations.getOrganizationList({
      limit,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      orgIds.add(org.id);
    }

    offset += data.length;
    if (offset >= totalCount) break;
    await sleep(THROTTLE_MS);
  }

  return orgIds;
}

// ---------------------------------------------------------------------------
// Phase 3: Count rows per orphaned org
// ---------------------------------------------------------------------------

async function getOrgDataSummary(
  db: ReturnType<typeof drizzle>,
  orgId: string,
): Promise<OrgDataSummary> {
  const tables: Record<string, number> = {};
  let totalRows = 0;

  for (const table of ORG_TABLES) {
    const result = await db.execute<{ count: string }>(
      sql.raw(
        `SELECT COUNT(*) AS count FROM ${table} WHERE org_id = '${orgId.replace(/'/g, "''")}'`,
      ),
    );
    const count = parseInt(result[0]?.count ?? "0", 10);
    if (count > 0) {
      tables[table] = count;
      totalRows += count;
    }
  }

  return { orgId, tables, totalRows };
}

// ---------------------------------------------------------------------------
// Phase 4: Clean up an orphaned org (same as webhook handler)
// ---------------------------------------------------------------------------

async function cleanupOrphanedOrg(
  db: ReturnType<typeof drizzle>,
  orgId: string,
): Promise<void> {
  // We can't use the app's service functions directly (they depend on
  // globalThis.services). Instead, execute the same SQL deletion sequence.

  // Phase 1: External services — skip in migration script.
  // Stripe subscriptions for deleted orgs are likely already expired/cancelled.
  // Telegram webhooks for deleted orgs will 404 harmlessly.
  // Connector tokens will expire on their own.
  // This is a data cleanup script, not a real-time webhook handler.
  console.log(`    Skipping external service cleanup (best-effort, see notes)`);

  // Phase 2: S3 cleanup — skip in migration script.
  // S3 objects for orphaned orgs can be cleaned up separately if needed.
  // The storages.s3_prefix values are logged for manual cleanup.
  const storageRows = await db.execute<{ s3_prefix: string }>(
    sql.raw(
      `SELECT s3_prefix FROM storages WHERE org_id = '${orgId.replace(/'/g, "''")}'`,
    ),
  );
  if (storageRows.length > 0) {
    console.log(
      `    S3 prefixes to clean manually: ${storageRows
        .map((r) => {
          return r.s3_prefix;
        })
        .join(", ")}`,
    );
  }

  const exportRows = await db.execute<{ s3_key: string }>(
    sql.raw(
      `SELECT s3_key FROM export_jobs WHERE org_id = '${orgId.replace(/'/g, "''")}'AND s3_key IS NOT NULL`,
    ),
  );
  if (exportRows.length > 0) {
    console.log(
      `    Export S3 keys to clean manually: ${exportRows
        .map((r) => {
          return r.s3_key;
        })
        .join(", ")}`,
    );
  }

  // Phase 3: Database cleanup (same order as the Clerk cleanup service)

  // Step 1: Slack cleanup
  const slackRows = await db.execute<{ slack_workspace_id: string }>(
    sql.raw(
      `SELECT slack_workspace_id FROM slack_org_installations WHERE org_id = '${orgId.replace(/'/g, "''")}'`,
    ),
  );
  for (const row of slackRows) {
    const wsId = row.slack_workspace_id.replace(/'/g, "''");
    // Delete connections (cascades to thread sessions)
    await db.execute(
      sql.raw(
        `DELETE FROM slack_org_connections WHERE slack_workspace_id = '${wsId}'`,
      ),
    );
    // Delete installation
    await db.execute(
      sql.raw(
        `DELETE FROM slack_org_installations WHERE slack_workspace_id = '${wsId}'`,
      ),
    );
  }

  // Step 2: Aggregate roots with CASCADE
  const escaped = orgId.replace(/'/g, "''");
  // Schedules first: lastRunId FK (no CASCADE) blocks agent_runs deletion
  await db.execute(
    sql.raw(`DELETE FROM zero_agent_schedules WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM agent_runs WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM agent_composes WHERE org_id = '${escaped}'`),
  );
  await db.execute(sql.raw(`DELETE FROM storages WHERE org_id = '${escaped}'`));
  await db.execute(
    sql.raw(`DELETE FROM model_providers WHERE org_id = '${escaped}'`),
  );
  await db.execute(sql.raw(`DELETE FROM secrets WHERE org_id = '${escaped}'`));

  // Step 3: Tables without CASCADE
  await db.execute(
    sql.raw(`DELETE FROM connectors WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM variables WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM usage_daily WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM export_jobs WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM zero_agents WHERE org_id = '${escaped}'`),
  );

  // Step 4: Membership tables
  await db.execute(
    sql.raw(`DELETE FROM org_members_cache WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM org_members_metadata WHERE org_id = '${escaped}'`),
  );

  // Step 5: Org identity (LAST)
  await db.execute(
    sql.raw(`DELETE FROM org_cache WHERE org_id = '${escaped}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM org_metadata WHERE org_id = '${escaped}'`),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) throw new Error("CLERK_SECRET_KEY is required");

  console.log("=== Cleanup Orphaned Org Data ===");
  console.log(
    `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  if (SINGLE_ORG_ID) {
    console.log(`Target: ${SINGLE_ORG_ID} (single-org mode)`);
  }
  console.log();

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);
  const clerk = createClerkClient({ secretKey: clerkSecretKey });

  try {
    // Step 1: Get all org IDs from DB
    console.log("Scanning database for org IDs...");
    const dbOrgIds = SINGLE_ORG_ID
      ? new Set([SINGLE_ORG_ID])
      : await getAllDbOrgIds(db);
    console.log(`  Found ${dbOrgIds.size} distinct org IDs in database\n`);

    // Step 2: Get all org IDs from Clerk
    console.log("Fetching organizations from Clerk...");
    const clerkOrgIds = await getAllClerkOrgIds(clerk);
    console.log(`  Found ${clerkOrgIds.size} organizations in Clerk\n`);

    // Step 3: Find orphans (in DB but not in Clerk, excluding system org IDs)
    const orphanedOrgIds = [...dbOrgIds].filter((id) => {
      return !clerkOrgIds.has(id) && !SYSTEM_ORG_IDS.has(id);
    });
    console.log(`Found ${orphanedOrgIds.length} orphaned org(s)\n`);

    if (orphanedOrgIds.length === 0) {
      console.log("No orphaned orgs found. Nothing to clean up.");
      return;
    }

    // Step 4: Show details and optionally clean up
    let totalCleaned = 0;
    let totalRows = 0;

    for (let i = 0; i < orphanedOrgIds.length; i++) {
      const orgId = orphanedOrgIds[i]!;
      const idx = `[${i + 1}/${orphanedOrgIds.length}]`;

      const summary = await getOrgDataSummary(db, orgId);
      totalRows += summary.totalRows;

      console.log(`${idx} ${orgId} — ${summary.totalRows} rows:`);
      for (const [table, count] of Object.entries(summary.tables)) {
        console.log(`    ${table}: ${count}`);
      }

      if (!DRY_RUN) {
        try {
          await cleanupOrphanedOrg(db, orgId);
          totalCleaned++;
          console.log(`  ✓ Cleaned\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ Failed: ${msg}\n`);
        }
      } else {
        console.log(`  (dry-run — would clean)\n`);
      }
    }

    // Summary
    console.log("=== Summary ===");
    console.log(`Orphaned orgs: ${orphanedOrgIds.length}`);
    console.log(`Total orphaned rows: ${totalRows}`);
    if (!DRY_RUN) {
      console.log(`Cleaned: ${totalCleaned}`);
      console.log(`Failed: ${orphanedOrgIds.length - totalCleaned}`);
    } else {
      console.log(
        "\n⚠ Dry run — no changes were made. Pass --migrate to execute.",
      );
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
