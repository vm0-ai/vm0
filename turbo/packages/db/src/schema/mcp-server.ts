import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ref: varchar("ref", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    endpoint: varchar("endpoint", { length: 2048 }).notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [uniqueIndex("uq_mcp_servers_org_ref").on(table.orgId, table.ref)];
  },
);
