import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { zeroAgents } from "./zero-agent";
import { orgCustomConnectors } from "./org-custom-connector";

/**
 * Per-agent authorization for org custom connectors.
 * Sparse model: presence of a row = user has explicitly authorized this agent
 * to use this custom connector. A user's secret on `org_custom_connector_secrets`
 * alone is not enough; the mitm firewall is only synthesized when an agent is
 * listed here.
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
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    customConnectorId: uuid("custom_connector_id")
      .notNull()
      .references(
        () => {
          return orgCustomConnectors.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
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
    ];
  },
);
