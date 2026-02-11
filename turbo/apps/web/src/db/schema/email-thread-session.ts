import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { agentSessions } from "./agent-session";

/**
 * Email Thread Sessions table
 * Maps email threads to VM0 agent sessions for conversation continuity
 * Allows agents to maintain context across email reply chains
 */
export const emailThreadSessions = pgTable(
  "email_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    composeId: uuid("compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "cascade" }),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    lastEmailMessageId: varchar("last_email_message_id", { length: 512 }),
    replyToToken: varchar("reply_to_token", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_email_thread_sessions_reply_token").on(table.replyToToken),
    index("idx_email_thread_sessions_user").on(table.userId),
  ],
);
