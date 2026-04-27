#!/usr/bin/env tsx

/**
 * Batch backfill Clerk Organization IDs for existing scopes.
 *
 * Phase 2.5 of the scope-unification migration: creates a Clerk Organization
 * for every scope that still has `clerkOrgId = NULL`, then writes the org ID
 * back to the row. After this completes, Phase 3 can add a NOT NULL constraint.
 *
 * Usage:
 *   tsx scripts/migrations/001-backfill-clerk-orgs/backfill.ts [--migrate] [--user-id=<clerkUserId>]
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required
 */

import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNull, asc, sql } from "drizzle-orm";
import postgres from "postgres";

import { scopes } from "@vm0/db/schema/scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeRow {
  id: string;
  slug: string;
  ownerId: string | null;
}

interface Stats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    "user-id": { type: "string" },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;
const USER_ID = args["user-id"];

// ---------------------------------------------------------------------------
// Clerk helpers
// ---------------------------------------------------------------------------

const THROTTLE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatus(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as Record<string, unknown>).status === "number"
  ) {
    return (err as Record<string, unknown>).status as number;
  }
  return undefined;
}

function isTransientError(err: unknown): boolean {
  const status = getStatus(err);
  return status === 429 || (status !== undefined && status >= 500);
}

/**
 * Create a Clerk Organization with retry logic for transient errors.
 * Only passes `name` — no slug, letting Clerk auto-generate one.
 */
async function createClerkOrg(
  client: {
    organizations: {
      createOrganization: (params: {
        name: string;
        createdBy?: string;
      }) => Promise<{ id: string }>;
    };
  },
  name: string,
  ownerId: string | null,
): Promise<string> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const params: { name: string; createdBy?: string } = { name };
      if (ownerId) {
        params.createdBy = ownerId;
      }

      const org = await client.organizations.createOrganization(params);
      return org.id;
    } catch (err) {
      if (isTransientError(err) && attempt < MAX_ATTEMPTS) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(
          `  Transient error (status ${getStatus(err)}), retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`Failed after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Per-scope processing
// ---------------------------------------------------------------------------

type ClerkClient = {
  organizations: {
    createOrganization: (params: {
      name: string;
      createdBy?: string;
    }) => Promise<{ id: string }>;
  };
};

async function processScope(
  db: ReturnType<typeof drizzle>,
  clerkClient: ClerkClient,
  scope: ScopeRow,
  idx: string,
): Promise<"success" | "skipped" | "failed"> {
  try {
    const orgId = await createClerkOrg(clerkClient, scope.slug, scope.ownerId);
    await sleep(THROTTLE_MS);

    const result = await db
      .update(scopes)
      .set({ orgId, updatedAt: sql`NOW()` })
      .where(eq(scopes.id, scope.id))
      .returning({ id: scopes.id });

    if (result.length > 0) {
      console.log(`${idx} ✓ scope "${scope.slug}" → ${orgId}`);
      return "success";
    }
    console.log(`${idx} ⊘ scope "${scope.slug}" — already processed`);
    return "skipped";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${idx} ✗ scope "${scope.slug}" — ${message}`);
    if (
      typeof err === "object" &&
      err !== null &&
      "errors" in err &&
      Array.isArray((err as Record<string, unknown>).errors)
    ) {
      console.error(
        `     details:`,
        JSON.stringify((err as { errors: unknown[] }).errors, null, 2),
      );
    }
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  console.log("=== Backfill Clerk Organization IDs ===");
  console.log(
    `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  if (USER_ID) {
    console.log(`User: ${USER_ID} (single-scope mode)`);
  }
  console.log();

  let clerkClient: ClerkClient | null = null;

  if (!DRY_RUN) {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      throw new Error("CLERK_SECRET_KEY is required for --migrate");
    }
    const { createClerkClient } = await import("@clerk/backend");
    clerkClient = createClerkClient({ secretKey: clerkSecretKey });
  }

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);

  try {
    // Fetch scopes with NULL clerkOrgId, optionally filtered by ownerId
    // Note: scopes.ownerId was removed from the Drizzle schema (Phase 2),
    // so we use raw SQL column references for this legacy migration script.
    const whereClause = USER_ID
      ? and(isNull(scopes.orgId), sql`"scopes"."owner_id" = ${USER_ID}`)
      : isNull(scopes.orgId);

    const nullScopes: ScopeRow[] = await db
      .select({
        id: scopes.id,
        slug: scopes.slug,
        ownerId: sql<string | null>`"scopes"."owner_id"`,
      })
      .from(scopes)
      .where(whereClause)
      .orderBy(asc(scopes.createdAt));

    const total = nullScopes.length;
    console.log(`Found ${total} scope(s) with NULL clerkOrgId\n`);

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    const stats: Stats = { total, success: 0, failed: 0, skipped: 0 };

    for (let i = 0; i < nullScopes.length; i++) {
      const scope = nullScopes[i]!;
      const idx = `[${i + 1}/${total}]`;

      if (DRY_RUN) {
        console.log(
          `${idx} (dry-run) scope "${scope.slug}" — would create Clerk org`,
        );
        stats.success++;
        continue;
      }

      const result = await processScope(db, clerkClient!, scope, idx);
      stats[result]++;
    }

    // Final verification
    const [remaining] = await db
      .select({ count: sql<number>`count(*)` })
      .from(scopes)
      .where(isNull(scopes.orgId));

    console.log("\n=== Summary ===");
    console.log(`Total:     ${stats.total}`);
    console.log(`Success:   ${stats.success}`);
    console.log(`Failed:    ${stats.failed}`);
    console.log(`Skipped:   ${stats.skipped}`);
    console.log(
      `Remaining: ${remaining?.count ?? "unknown"} (scopes still with NULL clerkOrgId)`,
    );

    if (DRY_RUN) {
      console.log("\n⚠ Dry run — no changes were made.");
    }

    if (stats.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
