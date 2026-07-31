import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatTelegramContext = pgTable("chat_telegram_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  chatThreadId: uuid("chat_thread_id")
    .notNull()
    .references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  isDm: boolean("is_dm").notNull(),
  messageThreadId: integer("message_thread_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
