import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { feishuOrgConnections } from "./feishu-org-connection";

/**
 * Stable mapping from one Feishu user's view of a Feishu reply thread to the
 * canonical VM0 chat thread that owns its queue and session chain.
 */
export const feishuChatThreadRoutes = pgTable(
  "feishu_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return feishuOrgConnections.id;
        },
        { onDelete: "cascade" },
      ),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
    threadId: varchar("thread_id", { length: 255 }).notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_feishu_chat_thread_routes_conn_chat_thread_user").on(
        table.connectionId,
        table.chatId,
        table.threadId,
        table.userId,
      ),
    ];
  },
);
