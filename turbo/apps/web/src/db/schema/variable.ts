import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Variables table
 * Stores non-sensitive configuration variables per user within a scope.
 * Values are stored in plaintext (unlike secrets which are encrypted).
 * Uses clerk_org_id as the primary scope key (business requirement: scope_id → clerk_org_id migration).
 * scope_id column is retained for Phase 5 cleanup.
 */
export const variables = pgTable(
  "variables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Retained for Phase 5 cleanup — no longer used in queries
    scopeId: uuid("scope_id"),
    name: varchar("name", { length: 255 }).notNull(),
    value: text("value").notNull(),
    description: text("description"),
    userId: text("user_id").notNull(),
    clerkOrgId: text("clerk_org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_variables_clerk_org_user_name").on(
      table.clerkOrgId,
      table.userId,
      table.name,
    ),
    index("idx_variables_clerk_org").on(table.clerkOrgId),
  ],
);
