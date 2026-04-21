import {
  boolean,
  index,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * redemption_code_attempts — one row per redeem call (success or failure).
 * Used exclusively for per-user rate limiting on the redeem endpoint so that
 * the publicly-authenticated endpoint cannot be scripted into brute-forcing
 * the code space.
 *
 * The row is intentionally append-only; no update paths. Old rows can be
 * pruned by a background job (out of scope here — the lookup is a simple
 * count within a short sliding window).
 */
export const redemptionCodeAttempts = pgTable(
  "redemption_code_attempts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    attemptedAt: timestamp("attempted_at").defaultNow().notNull(),
    success: boolean("success").notNull(),
  },
  (table) => {
    return [
      // Composite index on (user_id, attempted_at DESC) keeps the hot count
      // query fast without scanning historical rows.
      index("idx_redemption_code_attempts_user_time").on(
        table.userId,
        table.attemptedAt,
      ),
    ];
  },
);
