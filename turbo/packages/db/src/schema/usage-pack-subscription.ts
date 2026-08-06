import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const USAGE_PACK_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
  "inactive",
] as const;

export type UsagePackAllocationStatus =
  (typeof USAGE_PACK_ALLOCATION_STATUSES)[number];

/**
 * Local correlation root for a usage-pack Stripe subscription.
 *
 * The UUID is copied to Stripe metadata before Checkout creation so lifecycle
 * events can resolve the immutable member allocation snapshot locally.
 */
export const usagePackSubscriptions = pgTable(
  "usage_pack_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    tier: varchar("tier", { length: 20 }).$type<"pro" | "team">().notNull(),
    stripePlanPriceId: text("stripe_plan_price_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: varchar("subscription_status", { length: 30 })
      .notNull()
      .default("checkout_pending"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_pack_subscriptions_checkout_session")
        .on(table.stripeCheckoutSessionId)
        .where(sql`${table.stripeCheckoutSessionId} IS NOT NULL`),
      uniqueIndex("uq_usage_pack_subscriptions_stripe_subscription")
        .on(table.stripeSubscriptionId)
        .where(sql`${table.stripeSubscriptionId} IS NOT NULL`),
      index("idx_usage_pack_subscriptions_org").on(table.orgId),
      index("idx_usage_pack_subscriptions_reconcile").on(
        table.subscriptionStatus,
        table.currentPeriodEnd,
      ),
      check(
        "chk_usage_pack_subscriptions_tier",
        sql`${table.tier} IN ('pro', 'team')`,
      ),
      check(
        "chk_usage_pack_subscriptions_period",
        sql`(${table.currentPeriodStart} IS NULL AND ${table.currentPeriodEnd} IS NULL) OR (${table.currentPeriodStart} IS NOT NULL AND ${table.currentPeriodEnd} IS NOT NULL AND ${table.currentPeriodEnd} > ${table.currentPeriodStart})`,
      ),
    ];
  },
);

/**
 * Immutable member or invitation package selections captured before Stripe
 * Checkout creation. Lifecycle fields advance after paid invoices, but owner
 * and package identity are never rewritten.
 */
export const usagePackAllocations = pgTable(
  "usage_pack_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    usagePackSubscriptionId: uuid("usage_pack_subscription_id")
      .notNull()
      .references(
        () => {
          return usagePackSubscriptions.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    invitationId: text("invitation_id"),
    usagePackUsd: integer("usage_pack_usd").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    status: varchar("status", { length: 30 })
      .$type<UsagePackAllocationStatus>()
      .notNull()
      .default("pending_payment"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_pack_allocations_current_user")
        .on(table.usagePackSubscriptionId, table.userId)
        .where(
          sql`${table.userId} IS NOT NULL AND ${table.status} <> 'inactive'`,
        ),
      uniqueIndex("uq_usage_pack_allocations_current_invitation")
        .on(table.usagePackSubscriptionId, table.invitationId)
        .where(
          sql`${table.invitationId} IS NOT NULL AND ${table.status} <> 'inactive'`,
        ),
      index("idx_usage_pack_allocations_subscription_status").on(
        table.usagePackSubscriptionId,
        table.status,
      ),
      index("idx_usage_pack_allocations_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_usage_pack_allocations_org_invitation").on(
        table.orgId,
        table.invitationId,
      ),
      check(
        "chk_usage_pack_allocations_owner",
        sql`(${table.userId} IS NOT NULL AND ${table.invitationId} IS NULL) OR (${table.userId} IS NULL AND ${table.invitationId} IS NOT NULL)`,
      ),
      check(
        "chk_usage_pack_allocations_package",
        sql`${table.usagePackUsd} IN (20, 50, 100, 200)`,
      ),
      check(
        "chk_usage_pack_allocations_status",
        sql`${table.status} IN ('pending_payment', 'active', 'pending_invitation', 'inactive')`,
      ),
      check(
        "chk_usage_pack_allocations_period",
        sql`(${table.currentPeriodStart} IS NULL AND ${table.currentPeriodEnd} IS NULL) OR (${table.currentPeriodStart} IS NOT NULL AND ${table.currentPeriodEnd} IS NOT NULL AND ${table.currentPeriodEnd} > ${table.currentPeriodStart})`,
      ),
    ];
  },
);

/** One committed marker per successfully fulfilled Stripe invoice. */
export const usagePackInvoiceFulfillments = pgTable(
  "usage_pack_invoice_fulfillments",
  {
    stripeInvoiceId: text("stripe_invoice_id").primaryKey(),
    usagePackSubscriptionId: uuid("usage_pack_subscription_id")
      .notNull()
      .references(
        () => {
          return usagePackSubscriptions.id;
        },
        { onDelete: "cascade" },
      ),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_usage_pack_invoice_fulfillments_subscription").on(
        table.usagePackSubscriptionId,
        table.periodEnd,
      ),
      check(
        "chk_usage_pack_invoice_fulfillments_period",
        sql`${table.periodStart} IS NULL OR ${table.periodEnd} > ${table.periodStart}`,
      ),
    ];
  },
);
