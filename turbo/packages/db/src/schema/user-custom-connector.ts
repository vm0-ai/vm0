import {
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agent";
import { orgCustomConnectors } from "./org-custom-connector";

/**
 * Per-agent authorization for org custom connectors.
 * Sparse model: presence of a row = user has explicitly authorized this agent
 * to use this custom connector. A user's manual values or OAuth connection
 * alone are not enough; the mitm firewall is only synthesized while a matching
 * grant is listed here.
 *
 * Unlike `user_connectors` (which has no FK to `org_custom_connectors`), both
 * FKs carry DB-level ON DELETE CASCADE so deleting a connector or an agent
 * automatically removes stale authorization rows — no app-level cleanup.
 */
export const userCustomConnectors = pgTable(
  "user_custom_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    customConnectorId: uuid("custom_connector_id").notNull(),
    permissionNames: text("permission_names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "user_custom_connectors_agent_id_agents_id_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      uniqueIndex("idx_user_custom_connectors_unique").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.customConnectorId,
      ),
      index("idx_user_custom_connectors_agent_user").on(
        table.agentId,
        table.userId,
      ),
      foreignKey({
        name: "fk_user_custom_connectors_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
    ];
  },
);
