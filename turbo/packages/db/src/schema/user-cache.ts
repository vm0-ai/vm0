import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * user_cache — DB-backed cache for Clerk user data.
 * Clerk remains the single source of truth; this table is a read-through cache
 * for contexts where no JWT is available (cron, CLI tokens, background jobs).
 */
export const userCache = pgTable("user_cache", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  orgListCachedAt: timestamp("org_list_cached_at"),
  cachedAt: timestamp("cached_at").defaultNow().notNull(),
});
