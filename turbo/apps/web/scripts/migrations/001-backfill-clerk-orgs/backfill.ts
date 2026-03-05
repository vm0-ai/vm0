#!/usr/bin/env tsx

/**
 * Batch backfill Clerk Organization IDs for existing scopes.
 *
 * Phase 2.5 of the scope-unification migration: creates a Clerk Organization
 * for every scope that still has `clerkOrgId = NULL`, then writes the org ID
 * back to the row. After this completes, Phase 3 can add a NOT NULL constraint.
 *
 * Usage:
 *   tsx scripts/migrations/001-backfill-clerk-orgs/backfill.ts [--dry-run] [--batch-size=100]
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required
 */

import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, isNull, asc, sql } from "drizzle-orm";
import postgres from "postgres";

import { scopes } from "../../../src/db/schema/scope";

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
    "dry-run": { type: "boolean", default: false },
    "batch-size": { type: "string", default: "100" },
  },
  strict: true,
});

const DRY_RUN = args["dry-run"] ?? false;
const BATCH_SIZE = Number(args["batch-size"]);

if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error("--batch-size must be a positive integer");
  process.exit(1);
}

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

function hasErrorCode(err: unknown, code: string): boolean {
  if (
    typeof err === "object" &&
    err !== null &&
    "errors" in err &&
    Array.isArray((err as Record<string, unknown>).errors)
  ) {
    return (err as { errors: Array<{ code?: string }> }).errors.some(
      (e) => e.code === code,
    );
  }
  return false;
}

function isSlugConflict(err: unknown): boolean {
  return getStatus(err) === 422 && hasErrorCode(err, "form_identifier_exists");
}

function isTransientError(err: unknown): boolean {
  const status = getStatus(err);
  return status === 429 || (status !== undefined && status >= 500);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Create a Clerk Organization with retry logic for slug conflicts and
 * transient errors.
 */
async function createClerkOrg(
  client: {
    organizations: {
      createOrganization: (params: {
        name: string;
        slug: string;
        createdBy?: string;
      }) => Promise<{ id: string }>;
    };
  },
  slug: string,
  ownerId: string | null,
): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let currentSlug = slug;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const params: { name: string; slug: string; createdBy?: string } = {
        name: currentSlug,
        slug: currentSlug,
      };
      if (ownerId) {
        params.createdBy = ownerId;
      }

      const org = await client.organizations.createOrganization(params);
      return org.id;
    } catch (err) {
      if (isSlugConflict(err) && attempt < MAX_ATTEMPTS) {
        currentSlug = `${slug}-${randomSuffix()}`;
        console.warn(
          `  Slug conflict for "${slug}", retrying with "${currentSlug}" (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        continue;
      }

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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required");
  }

  console.log("=== Backfill Clerk Organization IDs ===");
  console.log(`Dry run:    ${DRY_RUN}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log();

  const { createClerkClient } = await import("@clerk/backend");
  const clerkClient = createClerkClient({ secretKey: clerkSecretKey });

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);

  try {
    // Fetch all scopes with NULL clerkOrgId
    const nullScopes: ScopeRow[] = await db
      .select({
        id: scopes.id,
        slug: scopes.slug,
        ownerId: scopes.ownerId,
      })
      .from(scopes)
      .where(isNull(scopes.clerkOrgId))
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

      try {
        const orgId = await createClerkOrg(
          clerkClient,
          scope.slug,
          scope.ownerId,
        );
        await sleep(THROTTLE_MS);

        if (DRY_RUN) {
          console.log(`${idx} (dry-run) scope "${scope.slug}" → ${orgId}`);
          stats.success++;
        } else {
          const result = await db
            .update(scopes)
            .set({ clerkOrgId: orgId, updatedAt: new Date() })
            .where(eq(scopes.id, scope.id))
            .returning({ id: scopes.id });

          if (result.length > 0) {
            console.log(`${idx} ✓ scope "${scope.slug}" → ${orgId}`);
            stats.success++;
          } else {
            console.log(`${idx} ⊘ scope "${scope.slug}" — already processed`);
            stats.skipped++;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${idx} ✗ scope "${scope.slug}" — ${message}`);
        stats.failed++;
      }
    }

    // Final verification
    const [remaining] = await db
      .select({ count: sql<number>`count(*)` })
      .from(scopes)
      .where(isNull(scopes.clerkOrgId));

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
