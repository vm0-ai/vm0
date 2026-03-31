import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-session";
import { agentComposes } from "./agent-compose";

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
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(
        () => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: varchar("org_id", { length: 255 }),
    lastEmailMessageId: varchar("last_email_message_id", { length: 512 }),
    replyToToken: varchar("reply_to_token", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_email_thread_sessions_reply_token").on(
        table.replyToToken,
      ),
      index("idx_email_thread_sessions_user").on(table.userId),
    ];
  },
);
