import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatFeishuContext = pgTable("chat_feishu_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  chatThreadId: uuid("chat_thread_id")
    .notNull()
    .references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
  chatOpenUrl: text("chat_open_url").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
