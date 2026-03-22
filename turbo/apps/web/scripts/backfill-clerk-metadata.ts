#!/usr/bin/env tsx

/**
 * One-time backfill script: reads ALL org/membership/user data from Clerk API
 * and writes to local DB tables (org_metadata, org_members_metadata, users).
 *
 * This ensures complete data coverage beyond what lazy migration (#5591) achieves,
 * since lazy migration only covers active users who trigger a read.
 *
 * Usage:
 *   dotenv -e .env.local -- tsx scripts/backfill-clerk-metadata.ts
 *   dotenv -e .env.local -- tsx scripts/backfill-clerk-metadata.ts --dry-run
 *
 * Required env vars: DATABASE_URL, CLERK_SECRET_KEY
 */

import {
  createClerkClient,
  type Organization,
  type OrganizationMembership,
  type User,
} from "@clerk/nextjs/server";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { orgMetadata } from "../src/db/schema/org-metadata";
import { orgMembersMetadata } from "../src/db/schema/org-members-metadata";
import { users } from "../src/db/schema/user";

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

// Accept any Drizzle PgDatabase so both postgres-js (script) and
// node-postgres (tests via globalThis.services.db) work.
export type Db = PgDatabase<PgQueryResultHKT>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Abort the backfill if more than this many per-item errors accumulate. */
export const MAX_ERRORS = 50;

export function createTooManyErrorsError(count: number): Error {
  const err = new Error(
    `Backfill aborted: ${count} errors exceeded threshold of ${MAX_ERRORS}`,
  );
  err.name = "TooManyErrorsError";
  return err;
}

function checkErrorThreshold(stats: BackfillStats): void {
  if (stats.errors.length > MAX_ERRORS) {
    throw createTooManyErrorsError(stats.errors.length);
  }
}

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
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await sleep(100); // rate-limit protection
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
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
  for await (const orgs of paginate<Organization>((p) =>
    clerk.organizations.getOrganizationList({ ...p }),
  )) {
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

        if (!dryRun) {
          await db
            .insert(orgMetadata)
            .values({
              orgId: org.id,
              tier: clerkTier,
              defaultAgentComposeId: clerkComposeId,
            })
            .onConflictDoUpdate({
              target: orgMetadata.orgId,
              set: {
                // Only update tier if DB still has default "free"
                tier: sql`CASE WHEN ${orgMetadata.tier} = 'free' THEN EXCLUDED.tier ELSE ${orgMetadata.tier} END`,
                // Only update defaultAgentComposeId if DB is null
                defaultAgentComposeId: sql`COALESCE(${orgMetadata.defaultAgentComposeId}, EXCLUDED.default_agent_compose_id)`,
                updatedAt: new Date(),
              },
            });
        }

        stats.orgs.upserted++;
        console.log(
          `  org ${org.id}: tier=${clerkTier}, composeId=${clerkComposeId ?? "null"}${dryRun ? " (dry-run)" : ""}`,
        );
      } catch (err) {
        stats.errors.push({
          type: "org",
          id: org.id,
          error: String(err),
        });
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
  for await (const orgs of paginate<Organization>((p) =>
    clerk.organizations.getOrganizationList({ ...p }),
  )) {
    for (const org of orgs) {
      for await (const memberships of paginate<OrganizationMembership>((p) =>
        clerk.organizations.getOrganizationMembershipList({
          organizationId: org.id,
          ...p,
        }),
      )) {
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
              const now = new Date();
              await db
                .insert(orgMembersMetadata)
                .values({
                  orgId: org.id,
                  userId,
                  timezone:
                    typeof meta.timezone === "string" ? meta.timezone : null,
                  notifyEmail: meta.notify_email === true,
                  notifySlack: meta.notify_slack !== false,
                  pinnedAgentIds: toStringArray(meta.pinned_agent_ids),
                  sendMode: parseSendMode(meta.send_mode),
                  onboardingDone: meta.onboarding_done === true,
                  createdAt: now,
                  updatedAt: now,
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
  for await (const clerkUsers of paginate<User>((p) =>
    clerk.users.getUserList({ ...p }),
  )) {
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
              set: { emailUnsubscribed: true, updatedAt: new Date() },
            });
        }

        stats.users.upserted++;
        console.log(
          `  user ${user.id}: email_unsubscribed=true${dryRun ? " (dry-run)" : ""}`,
        );
      } catch (err) {
        stats.errors.push({
          type: "user",
          id: user.id,
          error: String(err),
        });
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
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY environment variable is required");
  }

  const clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  const sqlClient = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sqlClient);

  const stats = newStats();

  try {
    if (dryRun) {
      console.log("DRY RUN MODE — no DB writes will occur\n");
    }

    console.log("Phase 1: Backfilling org_metadata...");
    await backfillOrgMetadata(clerk, db, stats, dryRun);

    console.log("\nPhase 2: Backfilling org_members_metadata...");
    await backfillOrgMembersMetadata(clerk, db, stats, dryRun);

    console.log("\nPhase 3: Backfilling users...");
    await backfillUsers(clerk, db, stats, dryRun);

    console.log("\n=== Backfill Summary ===");
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
  } finally {
    await sqlClient.end();
  }
}

// Only run main() when executed directly (not imported by tests)
const isDirectRun =
  process.argv[1]?.includes("backfill-clerk-metadata") ?? false;
if (isDirectRun) {
  await main();
}
