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
    // Compatibility bridge for pre-#23793 releases. Remove in #23794.
    legacyConnectorType: varchar("connector_type", {
      length: 64,
    }).notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_user_connectors_unique").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.legacyConnectorType,
      ),
      uniqueIndex("idx_user_connectors_unique_slug").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.connectorSlug,
      ),
      index("idx_user_connectors_agent_user").on(table.agentId, table.userId),
      check(
        "chk_user_connectors_slug_matches_type",
        sql`${table.connectorSlug} IS NOT NULL
          AND ${table.connectorSlug} = ${table.legacyConnectorType}`,
      ),
    ];
  },
);
