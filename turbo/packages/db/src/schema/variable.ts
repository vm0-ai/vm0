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
 * Stores non-sensitive configuration variables per user within an org
 * Values are stored in plaintext (unlike secrets which are encrypted)
 */
export const variables = pgTable(
  "variables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    value: text("value").notNull(),
    description: text("description"),
    type: varchar("type", { length: 50 }).notNull().default("user"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_variables_org").on(table.orgId),
      uniqueIndex("idx_variables_org_user_type_name").on(
        table.orgId,
        table.userId,
        table.type,
        table.name,
      ),
    ];
  },
);
