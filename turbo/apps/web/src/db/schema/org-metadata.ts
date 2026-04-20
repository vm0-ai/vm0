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
    // New orgs start with 100000 starter credits. Existing orgs retain their
    // current balance (migrations 0180 and 0257 only changed the column DEFAULT, not rows).
    credits: bigint("credits", { mode: "number" }).notNull().default(100_000),
    tier: text("tier").notNull().default("free"),
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agentComposes.id;
      },
      { onDelete: "set null" },
    ),
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
    // AgentPhone phone channel fields
    agentphoneAgentId: varchar("agentphone_agent_id", { length: 255 }),
    agentphoneNumberId: varchar("agentphone_number_id", { length: 255 }),
    agentphoneNumber: varchar("agentphone_number", { length: 20 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [uniqueIndex("uq_org_stripe_customer").on(table.stripeCustomerId)];
  },
);
