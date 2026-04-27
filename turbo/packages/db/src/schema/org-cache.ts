import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * org_cache — DB-backed cache for Clerk org identity (slug, name).
 * Clerk remains the single source of truth; this table is a
 * read-through cache for contexts where no JWT is available
 * (cron, CLI tokens, cross-org access).
 */
export const orgCache = pgTable(
  "org_cache",
  {
    orgId: text("org_id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull().default(""),
    createdBy: text("created_by"),
    cachedAt: timestamp("cached_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_org_cache_slug").on(table.slug)];
  },
);
