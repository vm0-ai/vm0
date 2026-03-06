import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";

/**
 * Variables table
 * Stores non-sensitive configuration variables per user within a scope
 * Values are stored in plaintext (unlike secrets which are encrypted)
 */
export const variables = pgTable(
  "variables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    value: text("value").notNull(),
    description: text("description"),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_variables_scope_user_name").on(
      table.scopeId,
      table.userId,
      table.name,
    ),
    index("idx_variables_scope").on(table.scopeId),
  ],
);
