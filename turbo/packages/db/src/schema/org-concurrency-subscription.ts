import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Current Stripe subscription state for paid concurrency add-ons.
 *
 * Invoice line entitlements remain the immutable audit trail. This table is
 * the Stripe-state-backed view used for runtime limits and billing UI.
 */
export const orgConcurrencySubscriptions = pgTable(
  "org_concurrency_subscriptions",
  {
    stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
    orgId: text("org_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    slots: integer("slots").notNull(),
    subscriptionStatus: varchar("subscription_status", { length: 20 }),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_org_concurrency_subscriptions_org").on(table.orgId),
      index("idx_org_concurrency_subscriptions_status_period").on(
        table.subscriptionStatus,
        table.currentPeriodEnd,
      ),
      check("chk_org_concurrency_subscriptions_slots", sql`${table.slots} > 0`),
    ];
  },
);
