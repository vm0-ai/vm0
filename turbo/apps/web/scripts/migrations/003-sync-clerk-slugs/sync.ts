#!/usr/bin/env tsx

/**
 * Audit and sync scope slugs with Clerk organization slugs.
 *
 * Compares scopes.slug in the database with the corresponding Clerk org slug.
 * In migrate mode, updates Clerk org slugs to match the database (DB is source of truth).
 *
 * Usage:
 *   tsx scripts/migrations/003-sync-clerk-slugs/sync.ts [--migrate]
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required (we read from Clerk API even in dry-run)
 */

import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { asc } from "drizzle-orm";
import postgres from "postgres";
import { createClerkClient } from "@clerk/backend";

import { scopes } from "@vm0/db/schema/scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScopeRow {
  id: string;
  slug: string;
  orgId: string;
}

interface Stats {
  total: number;
  matched: number;
  mismatched: number;
  skipped: number;
  notFound: number;
  updated: number;
  failed: number;
}

type ProcessResult =
  | "matched"
  | "mismatched"
  | "skipped"
  | "not_found"
  | "updated"
  | "failed";

type ClerkClient = ReturnType<typeof createClerkClient>;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THROTTLE_MS = 100;
const MAX_ATTEMPTS = 3;

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

function isNotFoundError(err: unknown): boolean {
  return getStatus(err) === 404;
}

function isSlugConflictError(err: unknown): boolean {
  const status = getStatus(err);
  return status === 422 || status === 400;
}

function isSentinelOrgId(orgId: string): boolean {
  return orgId.startsWith("org_backfill_") || orgId.startsWith("pending_");
}

// ---------------------------------------------------------------------------
// Clerk API operations with retry
// ---------------------------------------------------------------------------

async function fetchClerkOrg(
  client: ClerkClient,
  orgId: string,
): Promise<{ slug: string } | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.organizations.getOrganization({
        organizationId: orgId,
      });
    } catch (err) {
      if (isNotFoundError(err)) return null;
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
  throw new Error(`Failed to fetch Clerk org after ${MAX_ATTEMPTS} attempts`);
}

async function updateClerkOrgSlug(
  client: ClerkClient,
  orgId: string,
  slug: string,
): Promise<"updated" | "conflict"> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await client.organizations.updateOrganization(orgId, { slug });
      return "updated";
    } catch (err) {
      if (isSlugConflictError(err)) return "conflict";
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
  throw new Error(
    `Failed to update Clerk org slug after ${MAX_ATTEMPTS} attempts`,
  );
}

// ---------------------------------------------------------------------------
// Per-scope processing
// ---------------------------------------------------------------------------

async function processScope(
  client: ClerkClient,
  scope: ScopeRow,
  idx: string,
): Promise<ProcessResult> {
  if (isSentinelOrgId(scope.orgId)) {
    console.log(`${idx} ⊘ SKIPPED: scope "${scope.slug}" — sentinel orgId`);
    return "skipped";
  }

  try {
    const org = await fetchClerkOrg(client, scope.orgId);
    await sleep(THROTTLE_MS);

    if (!org) {
      console.log(
        `${idx} ⚠ NOT FOUND: scope "${scope.slug}" — Clerk org not found`,
      );
      return "not_found";
    }

    if (org.slug === scope.slug) {
      console.log(`${idx} ✓ scope "${scope.slug}" matches Clerk org slug`);
      return "matched";
    }

    if (DRY_RUN) {
      console.log(
        `${idx} ✗ MISMATCH: scope "${scope.slug}" vs Clerk org "${org.slug}"`,
      );
      return "mismatched";
    }

    const result = await updateClerkOrgSlug(client, scope.orgId, scope.slug);
    await sleep(THROTTLE_MS);

    if (result === "conflict") {
      console.error(
        `${idx} ✗ CONFLICT: scope "${scope.slug}" — slug already taken in Clerk`,
      );
      return "failed";
    }

    console.log(
      `${idx} ✓ SYNCED: scope "${scope.slug}" (was "${org.slug}" in Clerk)`,
    );
    return "updated";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${idx} ✗ ERROR: scope "${scope.slug}" — ${message}`);
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

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required");
  }

  console.log("=== Audit & Sync Scope Slugs with Clerk Org Slugs ===");
  console.log(
    `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  console.log();

  const client = createClerkClient({ secretKey: clerkSecretKey });
  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);

  try {
    const allScopes: ScopeRow[] = await db
      .select({
        id: scopes.id,
        slug: scopes.slug,
        orgId: scopes.orgId,
      })
      .from(scopes)
      .orderBy(asc(scopes.createdAt));

    const total = allScopes.length;
    console.log(`Found ${total} scope(s)\n`);

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    const stats: Stats = {
      total,
      matched: 0,
      mismatched: 0,
      skipped: 0,
      notFound: 0,
      updated: 0,
      failed: 0,
    };

    for (let i = 0; i < allScopes.length; i++) {
      const scope = allScopes[i]!;
      const idx = `[${i + 1}/${total}]`;

      const result = await processScope(client, scope, idx);
      stats[result === "not_found" ? "notFound" : result]++;
    }

    console.log("\n=== Summary ===");
    console.log(`Total:      ${stats.total}`);
    console.log(`Matched:    ${stats.matched}`);
    console.log(`Mismatched: ${stats.mismatched}`);
    console.log(`Skipped:    ${stats.skipped} (sentinel orgId)`);
    console.log(`Not found:  ${stats.notFound} (Clerk org deleted)`);
    console.log(
      `Updated:    ${stats.updated}${DRY_RUN ? " (pass --migrate to sync)" : ""}`,
    );
    console.log(`Failed:     ${stats.failed}`);

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
  console.error("Sync failed:", err);
  process.exit(1);
});
