import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Slack Pending Questions table
 *
 * Stores askUserQuestion denials that have been posted as interactive
 * Block Kit cards to Slack. When a user clicks a button/checkbox, the
 * interactive handler looks up this record to reconstruct the context
 * and dispatch a new agent run with the user's answer.
 */
export const slackPendingQuestions = pgTable(
  "slack_pending_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: varchar("run_id", { length: 64 }).notNull(),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 64 }).notNull(),
    slackChannelId: varchar("slack_channel_id", { length: 64 }).notNull(),
    slackThreadTs: varchar("slack_thread_ts", { length: 64 }).notNull(),
    /** Message ts of the interactive card (set after posting) */
    slackMessageTs: varchar("slack_message_ts", { length: 64 }),
    userLinkId: uuid("user_link_id").notNull(),
    composeId: uuid("compose_id").notNull(),
    agentName: varchar("agent_name", { length: 128 }).notNull(),
    sessionId: uuid("session_id"),
    /** The raw questions array from AskUserQuestion tool_input */
    questions: jsonb("questions").notNull(),
    /** Set when user submits their answers */
    answeredAt: timestamp("answered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Auto-expire after 1 hour to prevent stale cards */
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("idx_slack_pending_questions_run_id").on(table.runId)],
);
