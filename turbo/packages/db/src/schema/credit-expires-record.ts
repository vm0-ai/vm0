import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * credit_expires_record — tracks credits with expiration times.
 * Free-tier starter credits (source='starter_grant') and subscription credits
 * (source='subscription_renewal') expire after 1 month; auto-recharge credits
 * do NOT expire and are NOT tracked here.
 * During deduction, expiring credits are consumed first (FEFO — First Expiring, First Out).
 */
export const creditExpiresRecord = pgTable(
  "credit_expires_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    source: varchar("source", { length: 50 }).notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    remaining: bigint("remaining", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_credit_expires_org_active")
        .on(table.orgId, table.expiresAt)
        .where(sql`remaining > 0`),
      uniqueIndex("uq_credit_expires_invoice")
        .on(table.orgId, table.stripeInvoiceId)
        .where(sql`stripe_invoice_id IS NOT NULL`),
      uniqueIndex("uq_credit_expires_starter_grant")
        .on(table.orgId)
        .where(sql`source = 'starter_grant'`),
    ];
  },
);
