import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatSlackContext = pgTable("chat_slack_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  chatThreadId: uuid("chat_thread_id")
    .notNull()
    .references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
  messagePermalink: text("message_permalink").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
