import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { slackUserLinks } from "./slack-user-link";
import { agentSessions } from "./agent-session";

/**
 * Slack Thread Sessions table
 * Maps Slack threads to VM0 agent sessions for conversation continuity
 * Allows agents to maintain context across multiple messages in a thread
 */
export const slackThreadSessions = pgTable(
  "slack_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slackUserLinkId: uuid("slack_user_link_id")
      .notNull()
      .references(() => slackUserLinks.id, { onDelete: "cascade" }),
    slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
    slackThreadTs: varchar("slack_thread_ts", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    lastProcessedMessageTs: varchar("last_processed_message_ts", {
      length: 255,
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Each thread + user link combination can only have one session
    uniqueIndex("idx_slack_thread_sessions_thread_user_link").on(
      table.slackUserLinkId,
      table.slackChannelId,
      table.slackThreadTs,
    ),
    // Index for looking up sessions by user link
    index("idx_slack_thread_sessions_user_link").on(table.slackUserLinkId),
  ],
);
