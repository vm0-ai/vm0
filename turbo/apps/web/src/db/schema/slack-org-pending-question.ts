import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { slackOrgConnections } from "./slack-org-connection";
import { agentComposes } from "./agent-compose";
import { agentSessions } from "./agent-session";

/**
 * Org-aware Slack pending questions table.
 * Stores askUserQuestion denials posted as interactive Block Kit cards.
 * When a user clicks a button/checkbox, the handler looks up this record
 * to reconstruct context and dispatch a new agent run with the answer.
 */
export const slackOrgPendingQuestions = pgTable(
  "slack_org_pending_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: varchar("run_id", { length: 64 }).notNull(),
    slackWorkspaceId: varchar("slack_workspace_id", { length: 255 }).notNull(),
    slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
    slackThreadTs: varchar("slack_thread_ts", { length: 255 }).notNull(),
    slackMessageTs: varchar("slack_message_ts", { length: 255 }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => slackOrgConnections.id),
    orgId: text("org_id").notNull(),
    composeId: uuid("compose_id")
      .notNull()
      .references(() => agentComposes.id),
    agentName: varchar("agent_name", { length: 255 }).notNull(),
    sessionId: uuid("session_id").references(() => agentSessions.id),
    questions: jsonb("questions").notNull(),
    answeredAt: timestamp("answered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("idx_slack_org_pending_questions_run_id").on(table.runId)],
);
