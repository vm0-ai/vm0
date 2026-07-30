import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { zeroAgents } from "./zero-agent";

/**
 * User Connectors table
 * Stores per-user, per-agent connector permissions (sparse: presence = enabled).
 * org→user connection is tracked in the `connectors` table.
 * This table tracks which of those connections a user has enabled for a specific agent.
 */
export const userConnectors = pgTable(
  "user_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_user_connectors_unique_slug").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.connectorSlug,
      ),
      index("idx_user_connectors_agent_user").on(table.agentId, table.userId),
    ];
  },
);
