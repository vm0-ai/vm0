import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-session";
import { agentphoneUserLinks } from "./agentphone-user-link";

/**
 * Maps an AgentPhone conversation to a VM0 agent session for continuity.
 *
 * MVP uses the "dm" root message sentinel because AgentPhone messages are a
 * one-to-one conversation with the shared number.
 */
export const agentphoneThreadSessions = pgTable(
  "agentphone_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentphoneUserLinkId: uuid("agentphone_user_link_id")
      .notNull()
      .references(
        () => {
          return agentphoneUserLinks.id;
        },
        { onDelete: "cascade" },
      ),
    conversationId: varchar("conversation_id", { length: 255 }),
    rootMessageId: varchar("root_message_id", { length: 255 }).notNull(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(
        () => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    lastProcessedMessageId: varchar("last_processed_message_id", {
      length: 255,
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_agentphone_thread_sessions_link_root").on(
        table.agentphoneUserLinkId,
        table.rootMessageId,
      ),
      index("idx_agentphone_thread_sessions_user_link").on(
        table.agentphoneUserLinkId,
      ),
    ];
  },
);
