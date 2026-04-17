#!/usr/bin/env tsx

/**
 * Backfill org_metadata.current_period_end from Stripe for paying orgs.
 *
 * Context (see issue #9777):
 *
 * Before the fix, `handleInvoicePaid` persisted `invoice.period_end` into
 * `org_metadata.current_period_end`. That field is the invoice's accrual
 * period end — for a renewal invoice, this collapses to the invoice
 * creation moment rather than the next renewal date. As a result, every
 * paying org that has gone through at least one renewal under the buggy
 * code path has a stale / past-dated `current_period_end` in the DB,
 * which causes `getOrgBillingPeriod` to fall through to Stripe on every
 * call (producing the "currentPeriodEnd is stale" log spam).
 *
 * This script reconciles every paying org's `current_period_end` against
 * Stripe by reading `subscription.items.data[0].current_period_end` — the
 * correct field for the subscription billing-cycle end.
 *
 * Usage (from turbo/apps/web):
 *   tsx scripts/migrations/007-backfill-current-period-end/backfill.ts
 *   tsx scripts/migrations/007-backfill-current-period-end/backfill.ts --migrate
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   STRIPE_SECRET_KEY   — Required when --migrate is passed
 */

import { parseArgs } from "node:util";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import Stripe from "stripe";
import { orgMetadata } from "../../../src/db/schema/org-metadata";

type Db = ReturnType<typeof drizzle>;
type ReconcileOutcome =
  | "updated"
  | "unchanged"
  | "noSubscriptionItem"
  | "pastDatedFromStripe"
  | "failed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PayingOrgRow {
  orgId: string;
  stripeSubscriptionId: string;
  currentPeriodEnd: Date | null;
}

interface Stats {
  total: number;
  updated: number;
  unchanged: number;
  noSubscriptionItem: number;
  pastDatedFromStripe: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THROTTLE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

function datesEqual(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

async function reconcileOrg(
  db: Db,
  stripe: Stripe,
  org: PayingOrgRow,
  idx: string,
  now: Date,
): Promise<ReconcileOutcome> {
  try {
    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscriptionId,
    );
    const itemPeriodEnd = subscription.items.data[0]?.current_period_end;

    if (!itemPeriodEnd) {
      console.warn(
        `${idx} ⊘ org=${org.orgId} sub=${org.stripeSubscriptionId} — subscription has no items[0].current_period_end`,
      );
      return "noSubscriptionItem";
    }

    const stripePeriodEnd = new Date(itemPeriodEnd * 1000);

    // Defensive: don't write a past-dated value. If Stripe returns a past
    // timestamp we log and skip rather than persist it (matching the guard
    // added to getOrgBillingPeriod).
    if (stripePeriodEnd < now) {
      console.warn(
        `${idx} ⊘ org=${org.orgId} sub=${org.stripeSubscriptionId} — Stripe period_end is in the past: ${stripePeriodEnd.toISOString()}`,
      );
      return "pastDatedFromStripe";
    }

    if (datesEqual(org.currentPeriodEnd, stripePeriodEnd)) {
      console.log(
        `${idx} = org=${org.orgId} current=${stripePeriodEnd.toISOString()} (already correct)`,
      );
      return "unchanged";
    }

    await db
      .update(orgMetadata)
      .set({ currentPeriodEnd: stripePeriodEnd, updatedAt: new Date() })
      .where(eq(orgMetadata.orgId, org.orgId));

    console.log(
      `${idx} ✓ org=${org.orgId} before=${org.currentPeriodEnd?.toISOString() ?? "null"} after=${stripePeriodEnd.toISOString()}`,
    );
    return "updated";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${idx} ✗ org=${org.orgId} sub=${org.stripeSubscriptionId} — ${message}`,
    );
    return "failed";
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

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!dryRun && !stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is required for --migrate");
  }

  console.log("=== Backfill org_metadata.current_period_end ===");
  console.log(
    `Mode: ${dryRun ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  console.log();

  const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);
  const stats: Stats = {
    total: 0,
    updated: 0,
    unchanged: 0,
    noSubscriptionItem: 0,
    pastDatedFromStripe: 0,
    failed: 0,
  };

  try {
    // Select every org with an active subscription — i.e. a non-null
    // stripe_subscription_id on a non-free tier. The tier check is
    // defensive: canceled subscriptions should already have
    // stripe_subscription_id cleared by handleSubscriptionDeleted.
    const rows = await db
      .select({
        orgId: orgMetadata.orgId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
      })
      .from(orgMetadata)
      .where(
        and(
          isNotNull(orgMetadata.stripeSubscriptionId),
          ne(orgMetadata.tier, "free"),
        ),
      );

    // Narrow the Drizzle result: the where clause guarantees non-null IDs
    // but the types stay nullable until we filter explicitly.
    const payingOrgs: PayingOrgRow[] = rows.flatMap((r) => {
      return r.stripeSubscriptionId === null
        ? []
        : [
            {
              orgId: r.orgId,
              stripeSubscriptionId: r.stripeSubscriptionId,
              currentPeriodEnd: r.currentPeriodEnd,
            },
          ];
    });

    stats.total = payingOrgs.length;
    console.log(
      `Found ${stats.total} paying org(s) with active subscription\n`,
    );

    if (stats.total === 0) {
      console.log("Nothing to do.");
      return;
    }

    const now = new Date();

    for (let i = 0; i < payingOrgs.length; i++) {
      const org = payingOrgs[i]!;
      const idx = `[${i + 1}/${stats.total}]`;

      if (dryRun) {
        console.log(
          `${idx} (dry-run) org=${org.orgId} sub=${org.stripeSubscriptionId} current=${
            org.currentPeriodEnd?.toISOString() ?? "null"
          } — would reconcile against Stripe`,
        );
        stats.updated++;
        continue;
      }

      const outcome = await reconcileOrg(db, stripe!, org, idx, now);
      stats[outcome]++;
      await sleep(THROTTLE_MS);
    }

    console.log("\n=== Summary ===");
    console.log(`Total:                 ${stats.total}`);
    console.log(`Updated:               ${stats.updated}`);
    console.log(`Unchanged:             ${stats.unchanged}`);
    console.log(`No subscription item:  ${stats.noSubscriptionItem}`);
    console.log(`Past-dated from Stripe: ${stats.pastDatedFromStripe}`);
    console.log(`Failed:                ${stats.failed}`);

    if (dryRun) {
      console.log(
        "\nDry run — no changes were made. Pass --migrate to execute.",
      );
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
