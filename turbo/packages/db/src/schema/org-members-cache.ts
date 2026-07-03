import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

/**
 * org_members_cache — DB-backed cache for Clerk membership role.
 * Clerk remains the source of truth for role; this table is a read-through cache
 * for contexts where no JWT is available (cron, run-builder, CLI tokens).
 *
 * Preferences are stored in org_members (not cached here).
 */
export const orgMembersCache = pgTable(
  "org_members_cache",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    cachedAt: timestamp("cached_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.orgId, table.userId] })];
  },
);
