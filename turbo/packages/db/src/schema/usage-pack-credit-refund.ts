import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  uuid,
} from "drizzle-orm/pg-core";

import { usagePackCreditGrants } from "./usage-pack-credit-grant";

export const USAGE_PACK_CREDIT_REFUND_SOURCE_TYPES = [
  "invoice",
  "payment_intent",
] as const;

export type UsagePackCreditRefundSourceType =
  (typeof USAGE_PACK_CREDIT_REFUND_SOURCE_TYPES)[number];

export const USAGE_PACK_CREDIT_REFUND_STATUSES = [
  "available",
  "pending",
  "processing",
  "succeeded",
  "failed",
] as const;

export type UsagePackCreditRefundStatus =
  (typeof USAGE_PACK_CREDIT_REFUND_STATUSES)[number];

/**
 * Stripe payment provenance and refund lifecycle for a purchased credit grant.
 * The row starts as available and snapshots the unspent portion when its member
 * leaves the organization.
 */
export const usagePackCreditRefunds = pgTable(
  "usage_pack_credit_refunds",
  {
    creditGrantId: uuid("credit_grant_id")
      .primaryKey()
      .references(
        () => {
          return usagePackCreditGrants.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    sourceType: varchar("source_type", { length: 20 })
      .$type<UsagePackCreditRefundSourceType>()
      .notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeInvoiceLineId: text("stripe_invoice_line_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    sourceAmountCents: integer("source_amount_cents").notNull(),
    status: varchar("status", { length: 20 })
      .$type<UsagePackCreditRefundStatus>()
      .notNull()
      .default("available"),
    refundCredits: bigint("refund_credits", { mode: "number" }),
    requestedAmountCents: integer("requested_amount_cents"),
    refundedAmountCents: integer("refunded_amount_cents"),
    stripeCreditNoteId: text("stripe_credit_note_id"),
    stripeRefundId: text("stripe_refund_id"),
    attempt: integer("attempt").notNull().default(1),
    failureReason: text("failure_reason"),
    refundedAt: timestamp("refunded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_usage_pack_credit_refunds_member").on(
        table.orgId,
        table.userId,
        table.status,
      ),
      index("idx_usage_pack_credit_refunds_reconcile").on(
        table.status,
        table.updatedAt,
      ),
      uniqueIndex("uq_usage_pack_credit_refunds_credit_note")
        .on(table.stripeCreditNoteId)
        .where(sql`${table.stripeCreditNoteId} IS NOT NULL`),
      uniqueIndex("uq_usage_pack_credit_refunds_refund")
        .on(table.stripeRefundId)
        .where(sql`${table.stripeRefundId} IS NOT NULL`),
      check(
        "chk_usage_pack_credit_refunds_source",
        sql`(${table.sourceType} = 'invoice' AND ${table.stripeInvoiceId} IS NOT NULL AND ${table.stripePaymentIntentId} IS NULL) OR (${table.sourceType} = 'payment_intent' AND ${table.stripeInvoiceId} IS NULL AND ${table.stripeInvoiceLineId} IS NULL AND ${table.stripePaymentIntentId} IS NOT NULL)`,
      ),
      check(
        "chk_usage_pack_credit_refunds_status",
        sql`${table.status} IN ('available', 'pending', 'processing', 'succeeded', 'failed')`,
      ),
      check(
        "chk_usage_pack_credit_refunds_source_amount",
        sql`${table.sourceAmountCents} >= 0`,
      ),
      check(
        "chk_usage_pack_credit_refunds_snapshot",
        sql`(${table.status} = 'available' AND ${table.refundCredits} IS NULL AND ${table.requestedAmountCents} IS NULL) OR (${table.status} <> 'available' AND ${table.refundCredits} > 0 AND ${table.requestedAmountCents} > 0)`,
      ),
      check(
        "chk_usage_pack_credit_refunds_refunded_amount",
        sql`${table.refundedAmountCents} IS NULL OR ${table.refundedAmountCents} >= 0`,
      ),
      check("chk_usage_pack_credit_refunds_attempt", sql`${table.attempt} > 0`),
    ];
  },
);
