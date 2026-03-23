import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * org_cache — DB-backed cache for Clerk org slug.
 * Clerk remains the single source of truth for slug; this table is a
 * read-through cache for contexts where no JWT is available
 * (cron, CLI tokens, cross-org access).
 *
 * Also caches billing period data with an independent TTL via `billingCachedAt`.
 */
export const orgCache = pgTable(
  "org_cache",
  {
    orgId: text("org_id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull().default(""),
    cachedAt: timestamp("cached_at").defaultNow().notNull(),
    // Billing period cache (independent TTL via billingCachedAt)
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    billingCachedAt: timestamp("billing_cached_at"),
  },
  (table) => [index("idx_org_cache_slug").on(table.slug)],
);
