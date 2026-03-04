import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { scopes } from "./scope";

/**
 * Scope Members table
 * Tracks which users belong to which scopes (replaces Clerk-only membership)
 * Also stores per-membership preferences (timezone, notification settings)
 */
export const scopeMembers = pgTable(
  "scope_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),
    role: varchar("role", { length: 16 }).notNull(), // 'admin' | 'member'
    timezone: varchar("timezone", { length: 50 }), // IANA timezone
    notifyEmail: boolean("notify_email").default(false).notNull(),
    notifySlack: boolean("notify_slack").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_scope_members_scope_user").on(table.scopeId, table.userId),
    index("idx_scope_members_scope").on(table.scopeId),
    index("idx_scope_members_user").on(table.userId),
    check(
      "scope_members_role_check",
      sql`${table.role} IN ('admin', 'member')`,
    ),
  ],
);
