import {
  pgTable,
  text,
  boolean,
  timestamp,
  primaryKey,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * org_members_cache — DB-backed cache for Clerk membership preferences.
 * Clerk remains the single source of truth; this table is a read-through cache
 * for contexts where no JWT is available (cron, run-builder, CLI tokens).
 */
export const orgMembersCache = pgTable(
  "org_members_cache",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    timezone: text("timezone"),
    notifyEmail: boolean("notify_email").notNull().default(false),
    notifySlack: boolean("notify_slack").notNull().default(true),
    pinnedAgentIds: jsonb("pinned_agent_ids").$type<string[]>().default([]),
    cachedAt: timestamp("cached_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] })],
);
