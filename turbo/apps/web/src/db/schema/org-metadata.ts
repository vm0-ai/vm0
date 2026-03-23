import {
  bigint,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * org_metadata — stores per-org data that is owned by the platform (not Clerk).
 * Holds credit balance, tier, default agent configuration, and Stripe billing fields.
 * Clerk remains source of truth for slug and membership only.
 */
export const orgMetadata = pgTable(
  "org_metadata",
  {
    orgId: text("org_id").primaryKey(),
    // New orgs start with 10000 starter credits. Existing orgs retain their
    // current balance (migration 0180 only changed the column DEFAULT, not rows).
    credits: bigint("credits", { mode: "number" }).notNull().default(10_000),
    tier: text("tier").notNull().default("free"),
    defaultAgentComposeId: uuid("default_agent_compose_id"),
    // Stripe billing fields
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: varchar("subscription_status", { length: 20 }),
    currentPeriodEnd: timestamp("current_period_end"),
    lastProcessedInvoiceId: text("last_processed_invoice_id"),
    // Auto-recharge configuration
    autoRechargeEnabled: boolean("auto_recharge_enabled")
      .notNull()
      .default(false),
    autoRechargeThreshold: bigint("auto_recharge_threshold", {
      mode: "number",
    }),
    autoRechargeAmount: bigint("auto_recharge_amount", { mode: "number" }),
    autoRechargePendingAt: timestamp("auto_recharge_pending_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("uq_org_stripe_customer").on(table.stripeCustomerId)],
);
