import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { teamsOrgConnections } from "./teams-org-connection";
import { agentSessions } from "./agent-session";

/**
 * Org-aware Microsoft Teams thread sessions table.
 * Maps Teams conversation threads to VM0 agent sessions for conversation
 * continuity. A Teams thread is anchored by conversation ID plus root activity
 * or thread ID.
 */
export const teamsOrgThreadSessions = pgTable(
  "teams_org_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return teamsOrgConnections.id;
        },
        { onDelete: "cascade" },
      ),
    teamsConversationId: varchar("teams_conversation_id", {
      length: 255,
    }).notNull(),
    teamsChannelId: varchar("teams_channel_id", { length: 255 }),
    teamsThreadId: varchar("teams_thread_id", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id").references(
      () => {
        return agentSessions.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_teams_org_thread_sessions_conn_conversation_thread").on(
        table.connectionId,
        table.teamsConversationId,
        table.teamsThreadId,
      ),
      index("idx_teams_org_thread_sessions_connection").on(table.connectionId),
    ];
  },
);
