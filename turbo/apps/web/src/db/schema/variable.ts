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
 * Stores non-sensitive configuration variables per user within a scope
 * Values are stored in plaintext (unlike secrets which are encrypted)
 */
export const variables = pgTable(
  "variables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    index("idx_variables_clerk_org").on(table.clerkOrgId),
    uniqueIndex("idx_variables_clerk_org_user_name").on(
      table.clerkOrgId,
      table.userId,
      table.name,
    ),
  ],
);
