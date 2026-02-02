import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { slackBindings } from "./slack-binding";
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
    slackBindingId: uuid("slack_binding_id")
      .notNull()
      .references(() => slackBindings.id, { onDelete: "cascade" }),
    slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
    slackThreadTs: varchar("slack_thread_ts", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Each thread can only have one session
    uniqueIndex("idx_slack_thread_sessions_thread").on(
      table.slackChannelId,
      table.slackThreadTs,
    ),
    // Index for looking up sessions by binding
    index("idx_slack_thread_sessions_binding").on(table.slackBindingId),
  ],
);
