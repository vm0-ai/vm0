import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * org_promo_redemption — serializes concurrent `/redeem/[campaign]` attempts
 * for the same (org, campaign) pair. The UNIQUE index is the race-safe dedup
 * mechanism: only one concurrent insert wins, so two admins in the same org
 * can't both kick off a fresh Stripe Checkout.
 *
 * The `stripeSessionId` is writable so the route can refresh it when an
 * abandoned Stripe session has expired (24h) and the user retries.
 */
export const orgPromoRedemption = pgTable(
  "org_promo_redemption",
  {
    orgId: text("org_id").notNull(),
    campaignKey: text("campaign_key").notNull(),
    stripeSessionId: text("stripe_session_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_org_promo_redemption").on(table.orgId, table.campaignKey),
    ];
  },
);
