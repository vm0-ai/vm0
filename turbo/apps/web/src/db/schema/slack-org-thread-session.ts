import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { slackOrgConnections } from "./slack-org-connection";
import { agentSessions } from "./agent-session";

/**
 * Org-aware Slack thread sessions table.
 * Maps Slack threads to VM0 agent sessions for conversation continuity.
 * Each connection + channel + thread combination has at most one session.
 */
export const slackOrgThreadSessions = pgTable(
  "slack_org_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => slackOrgConnections.id, { onDelete: "cascade" }),
    slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
    slackThreadTs: varchar("slack_thread_ts", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "set null" },
    ),
    lastProcessedMessageTs: varchar("last_processed_message_ts", {
      length: 255,
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_slack_org_thread_sessions_conn_channel_thread").on(
      table.connectionId,
      table.slackChannelId,
      table.slackThreadTs,
    ),
    index("idx_slack_org_thread_sessions_connection").on(table.connectionId),
  ],
);
