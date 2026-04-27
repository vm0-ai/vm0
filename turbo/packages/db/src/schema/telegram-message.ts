import {
  boolean,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { telegramInstallations } from "./telegram-installation";

/**
 * Telegram Messages table
 * Stores messages received by the bot for context retrieval.
 * Telegram Bot API has no history API, so we must store messages ourselves.
 * Messages are retained for 30 days (cleaned up by cron job).
 */
export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: varchar("installation_id", { length: 255 })
      .notNull()
      .references(
        () => {
          return telegramInstallations.telegramBotId;
        },
        { onDelete: "cascade" },
      ),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
    messageId: varchar("message_id", { length: 255 }).notNull(),
    fromUserId: varchar("from_user_id", { length: 255 }).notNull(),
    fromUsername: varchar("from_username", { length: 255 }),
    text: text("text"),
    /** Telegram file_id for photos — used to download images for context */
    fileId: varchar("file_id", { length: 255 }),
    isBot: boolean("is_bot").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Each message is unique per installation + chat + message ID
      uniqueIndex("idx_telegram_messages_unique").on(
        table.installationId,
        table.chatId,
        table.messageId,
      ),
      // Index for context queries (recent messages in a chat)
      index("idx_telegram_messages_chat").on(
        table.installationId,
        table.chatId,
      ),
      // Index for 30-day cleanup cron
      index("idx_telegram_messages_created_at").on(table.createdAt),
    ];
  },
);
