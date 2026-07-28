import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mcpServers } from "./mcp-server";
import { zeroAgents } from "./zero-agent";

export const mcpAgentGrants = pgTable(
  "mcp_agent_grants",
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
    serverId: uuid("server_id")
      .notNull()
      .references(
        () => {
          return mcpServers.id;
        },
        { onDelete: "cascade" },
      ),
    allowAllTools: boolean("allow_all_tools").notNull(),
    allowedToolNames: text("allowed_tool_names").array().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_mcp_agent_grants_scope").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.serverId,
      ),
      index("idx_mcp_agent_grants_agent_id").on(table.agentId),
      index("idx_mcp_agent_grants_server_id").on(table.serverId),
      check(
        "chk_mcp_agent_grants_tool_policy",
        sql`((${table.allowAllTools} AND cardinality(${table.allowedToolNames}) = 0) OR (NOT ${table.allowAllTools} AND cardinality(${table.allowedToolNames}) > 0))`,
      ),
    ];
  },
);
