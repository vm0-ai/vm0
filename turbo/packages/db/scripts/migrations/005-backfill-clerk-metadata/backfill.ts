#!/usr/bin/env tsx

/**
 * Backfill Clerk metadata into local DB tables.
 *
 * Reads ALL org/membership/user data from Clerk API and writes to
 * org_metadata, org_members_metadata, and users tables. Ensures complete
 * data coverage beyond what lazy migration (#5591) achieves.
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/005-backfill-clerk-metadata/backfill.ts
 *   pnpm exec tsx scripts/migrations/005-backfill-clerk-metadata/backfill.ts --migrate
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required
 */

import { parseArgs } from "node:util";
import { createClerkClient } from "@clerk/backend";
import type {
  Organization,
  OrganizationMembership,
  User,
} from "@clerk/backend";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { users } from "@vm0/db/schema/user";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillStats {
  orgs: { processed: number; upserted: number; skipped: number };
  members: { processed: number; inserted: number; skipped: number };
  users: { processed: number; upserted: number; skipped: number };
  errors: Array<{ type: string; id: string; error: string }>;
}

export type ClerkClient = ReturnType<typeof createClerkClient>;

// Accept any Drizzle PgDatabase so both postgres-js scripts and
// node-postgres-backed tests work.
export type Db = PgDatabase<PgQueryResultHKT>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THROTTLE_MS = 100;

/** Abort the backfill if more than this many per-item errors accumulate. */
export const MAX_ERRORS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function newStats(): BackfillStats {
  return {
    orgs: { processed: 0, upserted: 0, skipped: 0 },
    members: { processed: 0, inserted: 0, skipped: 0 },
    users: { processed: 0, upserted: 0, skipped: 0 },
    errors: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

function checkErrorThreshold(stats: BackfillStats): void {
  if (stats.errors.length > MAX_ERRORS) {
    const err = new Error(
      `Backfill aborted: ${stats.errors.length} errors exceeded threshold of ${MAX_ERRORS}`,
    );
    err.name = "TooManyErrorsError";
    throw err;
  }
}

/**
 * Paginate through a Clerk list endpoint using offset-based pagination.
 * Yields one page of results at a time, sleeping between pages to avoid
 * hitting Clerk rate limits.
 */
async function* paginate<T>(
  fetcher: (params: {
    limit: number;
    offset: number;
  }) => Promise<{ data: T[]; totalCount: number }>,
): AsyncGenerator<T[]> {
  let offset = 0;
  const limit = 100;
  for (;;) {
    const { data, totalCount } = await fetcher({ limit, offset });
    if (data.length === 0) break;
    yield data;
    offset += data.length;
    if (offset >= totalCount) break;
    await sleep(THROTTLE_MS);
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

function parseSendMode(value: unknown): "enter" | "cmd-enter" {
  return value === "cmd-enter" ? "cmd-enter" : "enter";
}

// ---------------------------------------------------------------------------
// Phase 1: org_metadata
// ---------------------------------------------------------------------------

export async function backfillOrgMetadata(
  clerk: ClerkClient,
  db: Db,
  stats: BackfillStats,
  dryRun: boolean,
): Promise<void> {
  for await (const orgs of paginate<Organization>((p) => {
    return clerk.organizations.getOrganizationList({ ...p });
  })) {
    for (const org of orgs) {
      stats.orgs.processed++;
      try {
        const meta = org.publicMetadata as Record<string, unknown> | undefined;
        const clerkTier =
          typeof meta?.tier === "string" && meta.tier !== ""
            ? meta.tier
            : "free";
        const clerkComposeId =
          typeof meta?.default_agent_compose_id === "string" &&
          meta.default_agent_compose_id !== ""
            ? meta.default_agent_compose_id
            : null;

        // Skip orgs with only default values (nothing to backfill)
        if (clerkTier === "free" && clerkComposeId === null) {
          stats.orgs.skipped++;
          continue;
        }

        // Since zero_agents.id = agent_composes.id (composeId), use directly
        const zeroAgentId: string | null = clerkComposeId ?? null;

        if (!dryRun) {
          // Intentionally does NOT call ensureStarterCreditGrant. This is a
          // one-shot historical Clerk-sync script gated by --migrate; newly-
          // inserted free orgs land at credits=0 here. Free orgs that still
          // need a starter grant are covered by migration 0283's backfill.
          await db
            .insert(orgMetadata)
            .values({
              orgId: org.id,
              tier: clerkTier,
              defaultAgentId: zeroAgentId,
            })
            .onConflictDoUpdate({
              target: orgMetadata.orgId,
              set: {
                // Only update tier if DB still has default "free"
                tier: sql`CASE WHEN ${orgMetadata.tier} = 'free' THEN EXCLUDED.tier ELSE ${orgMetadata.tier} END`,
                // Only update defaultAgentId if DB is null
                defaultAgentId: sql`COALESCE(${orgMetadata.defaultAgentId}, EXCLUDED.default_agent_id)`,
                updatedAt: sql`NOW()`,
              },
            });
        }

        stats.orgs.upserted++;
        console.log(
          `  org ${org.id}: tier=${clerkTier}, agentId=${zeroAgentId ?? "null"}${dryRun ? " (dry-run)" : ""}`,
        );
      } catch (err) {
        stats.errors.push({ type: "org", id: org.id, error: String(err) });
        console.log(`  ERROR org ${org.id}: ${err}`);
        checkErrorThreshold(stats);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: org_members_metadata
// ---------------------------------------------------------------------------

export async function backfillOrgMembersMetadata(
  clerk: ClerkClient,
  db: Db,
  stats: BackfillStats,
  dryRun: boolean,
): Promise<void> {
  for await (const orgs of paginate<Organization>((p) => {
    return clerk.organizations.getOrganizationList({ ...p });
  })) {
    for (const org of orgs) {
      for await (const memberships of paginate<OrganizationMembership>((p) => {
        return clerk.organizations.getOrganizationMembershipList({
          organizationId: org.id,
          ...p,
        });
      })) {
        for (const membership of memberships) {
          const userId = membership.publicUserData?.userId;
          if (!userId) continue;

          stats.members.processed++;
          try {
            const meta = membership.publicMetadata as
              | Record<string, unknown>
              | undefined;

            // Skip if no metadata to backfill
            if (!meta || Object.keys(meta).length === 0) {
              stats.members.skipped++;
              continue;
            }

            if (!dryRun) {
              await db
                .insert(orgMembersMetadata)
                .values({
                  orgId: org.id,
                  userId,
                  timezone:
                    typeof meta.timezone === "string" ? meta.timezone : null,
                  pinnedAgentIds: toStringArray(meta.pinned_agent_ids),
                  sendMode: parseSendMode(meta.send_mode),
                  onboardingDone: meta.onboarding_done === true,
                  createdAt: sql`NOW()`,
                  updatedAt: sql`NOW()`,
                })
                .onConflictDoNothing();
            }

            stats.members.inserted++;
            console.log(
              `  member ${org.id}/${userId}${dryRun ? " (dry-run)" : ""}`,
            );
          } catch (err) {
            stats.errors.push({
              type: "member",
              id: `${org.id}/${userId}`,
              error: String(err),
            });
            console.log(`  ERROR member ${org.id}/${userId}: ${err}`);
            checkErrorThreshold(stats);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: users
// ---------------------------------------------------------------------------

export async function backfillUsers(
  clerk: ClerkClient,
  db: Db,
  stats: BackfillStats,
  dryRun: boolean,
): Promise<void> {
  for await (const clerkUsers of paginate<User>((p) => {
    return clerk.users.getUserList({ ...p });
  })) {
    for (const user of clerkUsers) {
      stats.users.processed++;
      try {
        const meta = user.publicMetadata as Record<string, unknown> | undefined;

        // Only backfill if email_unsubscribed is true (never write false)
        if (meta?.email_unsubscribed !== true) {
          stats.users.skipped++;
          continue;
        }

        if (!dryRun) {
          await db
            .insert(users)
            .values({ id: user.id, emailUnsubscribed: true })
            .onConflictDoUpdate({
              target: users.id,
              set: { emailUnsubscribed: true, updatedAt: sql`NOW()` },
            });
        }

        stats.users.upserted++;
        console.log(
          `  user ${user.id}: email_unsubscribed=true${dryRun ? " (dry-run)" : ""}`,
        );
      } catch (err) {
        stats.errors.push({ type: "user", id: user.id, error: String(err) });
        console.log(`  ERROR user ${user.id}: ${err}`);
        checkErrorThreshold(stats);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
    },
    strict: true,
  });
  const dryRun = !args.migrate;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  console.log("=== Backfill Clerk Metadata ===");
  console.log(
    `Mode: ${dryRun ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  console.log();

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY is required");
  }
  const clerk = createClerkClient({ secretKey: clerkSecretKey });

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);
  const stats = newStats();

  try {
    console.log("Phase 1: Backfilling org_metadata...");
    await backfillOrgMetadata(clerk, db, stats, dryRun);

    console.log("\nPhase 2: Backfilling org_members_metadata...");
    await backfillOrgMembersMetadata(clerk, db, stats, dryRun);

    console.log("\nPhase 3: Backfilling users...");
    await backfillUsers(clerk, db, stats, dryRun);

    console.log("\n=== Summary ===");
    console.log(
      `Orgs:    ${stats.orgs.processed} processed, ${stats.orgs.upserted} upserted, ${stats.orgs.skipped} skipped`,
    );
    console.log(
      `Members: ${stats.members.processed} processed, ${stats.members.inserted} inserted, ${stats.members.skipped} skipped`,
    );
    console.log(
      `Users:   ${stats.users.processed} processed, ${stats.users.upserted} upserted, ${stats.users.skipped} skipped`,
    );
    if (stats.errors.length > 0) {
      console.log(`Errors:  ${stats.errors.length}`);
      for (const e of stats.errors) {
        console.log(`  - [${e.type}] ${e.id}: ${e.error}`);
      }
    }

    if (dryRun) {
      console.log(
        "\nDry run — no changes were made. Pass --migrate to execute.",
      );
    }

    if (stats.errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
  }
}

// Only run when executed directly (not imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}
