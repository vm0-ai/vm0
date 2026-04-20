import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * redemption_codes — single-use codes that grant credits to the redeeming org.
 *
 * Minting is restricted to vm0 staff orgs (see `isStaffOrg`); redemption is
 * open to any authenticated user.
 *
 * Single-use is enforced by an atomic
 *   UPDATE ... WHERE code = $1 AND redeemed_at IS NULL AND expires_at > now()
 *   RETURNING credits_per_code
 * inside the redemption transaction. On success the service also inserts
 * a row into `credit_expires_record` with source = "redemption" and
 * stripe_invoice_id = "redemption:<code>", piggy-backing on the existing
 * `uq_credit_expires_invoice` unique index for double-redeem idempotency.
 */
export const redemptionCodes = pgTable(
  "redemption_codes",
  {
    code: varchar("code", { length: 32 }).primaryKey(),
    creditsPerCode: bigint("credits_per_code", { mode: "number" }).notNull(),
    createdByOrgId: text("created_by_org_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    redeemedByOrgId: text("redeemed_by_org_id"),
    redeemedByUserId: text("redeemed_by_user_id"),
    redeemedAt: timestamp("redeemed_at"),
  },
  (table) => {
    return [
      index("idx_redemption_codes_created_by").on(
        table.createdByOrgId,
        table.createdAt,
      ),
    ];
  },
);
