import {
  check,
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { connectors } from "./connector";

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
    connectorId: uuid("connector_id").references(
      () => {
        return connectors.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_variables_org").on(table.orgId),
      index("idx_variables_connector")
        .on(table.connectorId)
        .where(sql`${table.connectorId} IS NOT NULL`),
      uniqueIndex("idx_variables_org_user_type_name").on(
        table.orgId,
        table.userId,
        table.type,
        table.name,
      ),
      check(
        "chk_variables_connector_owner_type",
        sql`(${table.type} = 'connector') = (${table.connectorId} IS NOT NULL)`,
      ),
    ];
  },
);
