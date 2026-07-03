import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Invoice-backed concurrency add-on entitlements.
 *
 * Each Stripe subscription invoice line creates one entitlement window. The
 * active slot count is the sum of slots where starts_at <= now < expires_at.
 */
export const orgConcurrencyEntitlements = pgTable(
  "org_concurrency_entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    stripeInvoiceLineId: text("stripe_invoice_line_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    slots: integer("slots").notNull(),
    startsAt: timestamp("starts_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_org_concurrency_entitlements_invoice_line").on(
        table.stripeInvoiceLineId,
      ),
      index("idx_org_concurrency_entitlements_org_active").on(
        table.orgId,
        table.startsAt,
        table.expiresAt,
      ),
      check("chk_org_concurrency_entitlements_slots", sql`${table.slots} > 0`),
      check(
        "chk_org_concurrency_entitlements_window",
        sql`${table.expiresAt} > ${table.startsAt}`,
      ),
    ];
  },
);
