import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { conversations } from "./conversation";

/**
 * Agent Sessions table
 * Lightweight compose ↔ conversation association for continue operations
 * Sessions always use HEAD compose version at runtime — no snapshotting
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentComposeId: uuid("agent_compose_id")
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    conversationId: uuid("conversation_id").references(
      (): AnyPgColumn => {
        return conversations.id;
      },
      {
        onDelete: "set null",
      },
    ),
    artifactNames: jsonb("artifact_names")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agent_sessions_user_compose").on(
        table.userId,
        table.agentComposeId,
      ),
      index("idx_agent_sessions_org").on(table.orgId),
    ];
  },
);
