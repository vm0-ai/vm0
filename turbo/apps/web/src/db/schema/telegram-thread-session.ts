import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { telegramUserLinks } from "./telegram-user-link";
import { agentSessions } from "./agent-session";

/**
 * Telegram Thread Sessions table
 * Maps Telegram chat conversations to VM0 agent sessions for conversation continuity
 * Uses reply-chain model: bot's first reply message_id serves as thread anchor
 * For DMs, rootMessageId is "dm" (single ongoing session per DM)
 */
export const telegramThreadSessions = pgTable(
  "telegram_thread_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserLinkId: uuid("telegram_user_link_id")
      .notNull()
      .references(
        () => {
          return telegramUserLinks.id;
        },
        { onDelete: "cascade" },
      ),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
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
      // Each chat + user link + root message combination can only have one session
      uniqueIndex("idx_telegram_thread_sessions_chat_user_link").on(
        table.telegramUserLinkId,
        table.chatId,
        table.rootMessageId,
      ),
      // Index for looking up sessions by user link
      index("idx_telegram_thread_sessions_user_link").on(
        table.telegramUserLinkId,
      ),
    ];
  },
);
