#!/usr/bin/env tsx

/**
 * Backfill Clerk metadata for existing scopes and members.
 *
 * Phase 1 of the Scope → Clerk migration: writes scope `tier` to Clerk org
 * publicMetadata, and member preferences (timezone, notifyEmail, notifySlack)
 * to Clerk membership publicMetadata.
 *
 * Usage:
 *   tsx scripts/migrations/002-backfill-clerk-metadata/backfill.ts [--migrate]
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required (for --migrate)
 */

import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, asc } from "drizzle-orm";
import postgres from "postgres";

import { scopes } from "../../../src/db/schema/scope";
import { scopeMembers } from "../../../src/db/schema/scope-member";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Stats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

interface ClerkOrganizationsApi {
  updateOrganizationMetadata: (
    orgId: string,
    params: { publicMetadata: Record<string, unknown> },
  ) => Promise<unknown>;
  updateOrganizationMembershipMetadata: (params: {
    organizationId: string;
    userId: string;
    publicMetadata: Record<string, unknown>;
  }) => Promise<unknown>;
}

interface ClerkClient {
  organizations: ClerkOrganizationsApi;
}

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

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
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
  throw new Error(`Failed after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Backfill: Scope tiers
// ---------------------------------------------------------------------------

async function backfillScopeTiers(
  db: ReturnType<typeof drizzle>,
  client: ClerkClient | null,
): Promise<Stats> {
  console.log("\n--- Backfilling scope tiers ---\n");

  const allScopes = await db
    .select({
      id: scopes.id,
      slug: scopes.slug,
      tier: scopes.tier,
      clerkOrgId: scopes.clerkOrgId,
    })
    .from(scopes)
    .orderBy(asc(scopes.createdAt));

  const total = allScopes.length;
  console.log(`Found ${total} scope(s)\n`);

  const stats: Stats = { total, success: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < allScopes.length; i++) {
    const scope = allScopes[i]!;
    const idx = `[${i + 1}/${total}]`;

    if (DRY_RUN) {
      console.log(
        `${idx} (dry-run) scope "${scope.slug}" — would write tier="${scope.tier}" to Clerk org ${scope.clerkOrgId}`,
      );
      stats.success++;
      continue;
    }

    try {
      await withRetry(() =>
        client!.organizations.updateOrganizationMetadata(scope.clerkOrgId, {
          publicMetadata: { tier: scope.tier },
        }),
      );
      await sleep(THROTTLE_MS);
      console.log(`${idx} ✓ scope "${scope.slug}" → tier="${scope.tier}"`);
      stats.success++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${idx} ✗ scope "${scope.slug}" — ${message}`);
      stats.failed++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Backfill: Member preferences
// ---------------------------------------------------------------------------

async function backfillMemberPreferences(
  db: ReturnType<typeof drizzle>,
  client: ClerkClient | null,
): Promise<Stats> {
  console.log("\n--- Backfilling member preferences ---\n");

  const members = await db
    .select({
      memberId: scopeMembers.id,
      userId: scopeMembers.userId,
      timezone: scopeMembers.timezone,
      notifyEmail: scopeMembers.notifyEmail,
      notifySlack: scopeMembers.notifySlack,
      clerkOrgId: scopes.clerkOrgId,
      scopeSlug: scopes.slug,
    })
    .from(scopeMembers)
    .innerJoin(scopes, eq(scopeMembers.scopeId, scopes.id))
    .orderBy(asc(scopeMembers.createdAt));

  // Filter to members with non-default preferences
  const membersWithPrefs = members.filter(
    (m) =>
      m.timezone !== null || m.notifyEmail !== false || m.notifySlack !== true,
  );

  const total = membersWithPrefs.length;
  console.log(
    `Found ${members.length} member(s), ${total} with non-default preferences\n`,
  );

  const stats: Stats = { total, success: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < membersWithPrefs.length; i++) {
    const member = membersWithPrefs[i]!;
    const idx = `[${i + 1}/${total}]`;
    const metadata: Record<string, unknown> = {};

    if (member.timezone !== null) {
      metadata.timezone = member.timezone;
    }
    if (member.notifyEmail !== false) {
      metadata.notify_email = member.notifyEmail;
    }
    if (member.notifySlack !== true) {
      metadata.notify_slack = member.notifySlack;
    }

    if (DRY_RUN) {
      console.log(
        `${idx} (dry-run) user "${member.userId}" in scope "${member.scopeSlug}" — would write ${JSON.stringify(metadata)}`,
      );
      stats.success++;
      continue;
    }

    try {
      await withRetry(() =>
        client!.organizations.updateOrganizationMembershipMetadata({
          organizationId: member.clerkOrgId,
          userId: member.userId,
          publicMetadata: metadata,
        }),
      );
      await sleep(THROTTLE_MS);
      console.log(
        `${idx} ✓ user "${member.userId}" in "${member.scopeSlug}" → ${JSON.stringify(metadata)}`,
      );
      stats.success++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `${idx} ✗ user "${member.userId}" in "${member.scopeSlug}" — ${message}`,
      );
      stats.failed++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  console.log("=== Backfill Clerk Metadata ===");
  console.log(
    `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  console.log();

  let client: ClerkClient | null = null;

  if (!DRY_RUN) {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      throw new Error("CLERK_SECRET_KEY is required for --migrate");
    }
    const { createClerkClient } = await import("@clerk/backend");
    client = createClerkClient({ secretKey: clerkSecretKey });
  }

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);

  try {
    const tierStats = await backfillScopeTiers(db, client);
    const prefStats = await backfillMemberPreferences(db, client);

    console.log("\n=== Summary ===");
    console.log(
      `Scope tiers:      ${tierStats.success} ok, ${tierStats.failed} failed (${tierStats.total} total)`,
    );
    console.log(
      `Member prefs:     ${prefStats.success} ok, ${prefStats.failed} failed (${prefStats.total} total)`,
    );

    if (DRY_RUN) {
      console.log("\n⚠ Dry run — no changes were made.");
    }

    if (tierStats.failed > 0 || prefStats.failed > 0) {
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
