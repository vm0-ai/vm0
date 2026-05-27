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
import { agentComposes } from "./agent-compose";

/**
 * org_metadata — stores per-org data that is owned by the platform (not Clerk).
 * Holds credit balance, tier, default agent configuration, and Stripe billing fields.
 * Clerk remains source of truth for slug and membership only.
 */
export const orgMetadata = pgTable(
  "org_metadata",
  {
    orgId: text("org_id").primaryKey(),
    // Credits are granted explicitly through Stripe invoices, one-time purchases,
    // or legacy/manual grants. The column DEFAULT is 0 — never rely on the
    // default to materialise a grant.
    credits: bigint("credits", { mode: "number" }).notNull().default(0),
    tier: text("tier").notNull().default("pro-suspend"),
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agentComposes.id;
      },
      { onDelete: "set null" },
    ),
    onboardingPaymentPending: boolean("onboarding_payment_pending")
      .notNull()
      .default(false),
    // Stripe billing fields
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: varchar("subscription_status", { length: 20 }),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
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
  (table) => {
    return [uniqueIndex("uq_org_stripe_customer").on(table.stripeCustomerId)];
  },
);
