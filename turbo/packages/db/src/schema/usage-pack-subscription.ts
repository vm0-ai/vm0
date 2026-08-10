import { sql } from "drizzle-orm";
import {
  bigint,
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

export const USAGE_PACK_ALLOCATION_CHANGE_KINDS = [
  "upgrade",
  "downgrade",
  "removal",
] as const;

export type UsagePackAllocationChangeKind =
  (typeof USAGE_PACK_ALLOCATION_CHANGE_KINDS)[number];

export const USAGE_PACK_ALLOCATION_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
  "completed",
  "failed",
] as const;

export type UsagePackAllocationChangeStatus =
  (typeof USAGE_PACK_ALLOCATION_CHANGE_STATUSES)[number];

export const USAGE_PACK_SUBSCRIPTION_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
  "completed",
  "failed",
] as const;

export type UsagePackSubscriptionChangeStatus =
  (typeof USAGE_PACK_SUBSCRIPTION_CHANGE_STATUSES)[number];

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
 * One persisted plan/package operation. Stripe applies upgrades in one pending
 * update; plan and package downgrades remain represented until the next billing
 * boundary.
 */
export const usagePackSubscriptionChanges = pgTable(
  "usage_pack_subscription_changes",
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
    sourceTier: varchar("source_tier", { length: 20 })
      .$type<"pro" | "team">()
      .notNull(),
    targetTier: varchar("target_tier", { length: 20 })
      .$type<"pro" | "team">()
      .notNull(),
    status: varchar("status", { length: 30 })
      .$type<UsagePackSubscriptionChangeStatus>()
      .notNull()
      .default("previewed"),
    prorationTimestamp: bigint("proration_timestamp", {
      mode: "number",
    }).notNull(),
    immediateAmountCents: integer("immediate_amount_cents").notNull(),
    nextRecurringAmountCents: integer("next_recurring_amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    previewExpiresAt: timestamp("preview_expires_at").notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripePendingUpdateExpiresAt: timestamp("stripe_pending_update_expires_at"),
    effectiveAt: timestamp("effective_at").notNull(),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_pack_subscription_changes_active_org")
        .on(table.orgId)
        .where(
          sql`${table.status} IN ('previewed', 'applying', 'pending_payment')`,
        ),
      uniqueIndex("uq_usage_pack_subscription_changes_stripe_invoice")
        .on(table.stripeInvoiceId)
        .where(sql`${table.stripeInvoiceId} IS NOT NULL`),
      index("idx_usage_pack_subscription_changes_subscription_status").on(
        table.usagePackSubscriptionId,
        table.status,
      ),
      index("idx_usage_pack_subscription_changes_reconcile").on(
        table.status,
        table.updatedAt,
      ),
      check(
        "chk_usage_pack_subscription_changes_tiers",
        sql`${table.sourceTier} IN ('pro', 'team') AND ${table.targetTier} IN ('pro', 'team')`,
      ),
      check(
        "chk_usage_pack_subscription_changes_status",
        sql`${table.status} IN ('previewed', 'applying', 'pending_payment', 'completed', 'failed')`,
      ),
      check(
        "chk_usage_pack_subscription_changes_amounts",
        sql`${table.immediateAmountCents} >= 0 AND ${table.nextRecurringAmountCents} >= 0`,
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
        .on(table.orgId, table.userId)
        .where(
          sql`${table.userId} IS NOT NULL AND ${table.status} <> 'inactive'`,
        ),
      uniqueIndex("uq_usage_pack_allocations_current_invitation")
        .on(table.orgId, table.invitationId)
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

/**
 * Immutable intent for one member package mutation. The current allocation is
 * retained until Stripe has either collected an upgrade or reached a scheduled
 * downgrade boundary, so failed and expired pending updates cannot leak into
 * the spendable projection.
 */
export const usagePackAllocationChanges = pgTable(
  "usage_pack_allocation_changes",
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
    subscriptionChangeId: uuid("subscription_change_id").references(
      () => {
        return usagePackSubscriptionChanges.id;
      },
      { onDelete: "cascade" },
    ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    sourceAllocationId: uuid("source_allocation_id")
      .notNull()
      .references(
        () => {
          return usagePackAllocations.id;
        },
        { onDelete: "cascade" },
      ),
    replacementAllocationId: uuid("replacement_allocation_id"),
    kind: varchar("kind", { length: 20 })
      .$type<UsagePackAllocationChangeKind>()
      .notNull(),
    status: varchar("status", { length: 30 })
      .$type<UsagePackAllocationChangeStatus>()
      .notNull()
      .default("previewed"),
    sourceUsagePackUsd: integer("source_usage_pack_usd").notNull(),
    sourceStripePriceId: text("source_stripe_price_id").notNull(),
    targetUsagePackUsd: integer("target_usage_pack_usd"),
    targetStripePriceId: text("target_stripe_price_id"),
    prorationTimestamp: bigint("proration_timestamp", { mode: "number" }),
    immediateAmountCents: integer("immediate_amount_cents"),
    nextRecurringAmountCents: integer("next_recurring_amount_cents"),
    currency: varchar("currency", { length: 3 }),
    effectiveAt: timestamp("effective_at"),
    previewExpiresAt: timestamp("preview_expires_at"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeScheduleId: text("stripe_schedule_id"),
    stripePendingUpdateExpiresAt: timestamp("stripe_pending_update_expires_at"),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_pack_changes_active_org")
        .on(table.orgId)
        .where(
          sql`${table.subscriptionChangeId} IS NULL AND ${table.status} IN ('previewed', 'applying', 'pending_payment')`,
        ),
      uniqueIndex("uq_usage_pack_changes_current_user")
        .on(table.orgId, table.userId)
        .where(
          sql`${table.status} IN ('previewed', 'applying', 'pending_payment', 'scheduled', 'applied')`,
        ),
      uniqueIndex("uq_usage_pack_changes_stripe_invoice")
        .on(table.stripeInvoiceId)
        .where(sql`${table.stripeInvoiceId} IS NOT NULL`),
      index("idx_usage_pack_changes_subscription_status").on(
        table.usagePackSubscriptionId,
        table.status,
      ),
      index("idx_usage_pack_changes_subscription_change").on(
        table.subscriptionChangeId,
      ),
      index("idx_usage_pack_changes_reconcile").on(
        table.status,
        table.updatedAt,
      ),
      check(
        "chk_usage_pack_changes_kind",
        sql`${table.kind} IN ('upgrade', 'downgrade', 'removal')`,
      ),
      check(
        "chk_usage_pack_changes_status",
        sql`${table.status} IN ('previewed', 'applying', 'pending_payment', 'scheduled', 'applied', 'completed', 'failed')`,
      ),
      check(
        "chk_usage_pack_changes_source_package",
        sql`${table.sourceUsagePackUsd} IN (20, 50, 100, 200)`,
      ),
      check(
        "chk_usage_pack_changes_target_package",
        sql`(${table.kind} = 'removal' AND ${table.targetUsagePackUsd} IS NULL AND ${table.targetStripePriceId} IS NULL) OR (${table.kind} <> 'removal' AND ${table.targetUsagePackUsd} IN (20, 50, 100, 200) AND ${table.targetStripePriceId} IS NOT NULL)`,
      ),
      check(
        "chk_usage_pack_changes_amounts",
        sql`(${table.immediateAmountCents} IS NULL OR ${table.immediateAmountCents} >= 0) AND (${table.nextRecurringAmountCents} IS NULL OR ${table.nextRecurringAmountCents} >= 0)`,
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
