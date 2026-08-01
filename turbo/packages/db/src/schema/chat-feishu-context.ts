import type { ChatFeishuMessageFiles } from "@vm0/db/jsonb-contracts/chat-feishu-context";
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
  /**
   * Server-private Feishu launch material retained with the trigger context.
   * Raw third-party content is intentionally retained permanently; read paths
   * must continue to project only the explicitly required columns.
   */
  conversationHistory: text("conversation_history"),
  messageText: text("message_text"),
  messageFiles: jsonb("message_files").$type<ChatFeishuMessageFiles>(),
  chatType: text("chat_type").$type<"group" | "p2p" | "topic_group">(),
  tenantKey: text("tenant_key"),
  chatId: text("chat_id"),
  messageId: text("message_id"),
  threadId: text("thread_id"),
  replyInThread: boolean("reply_in_thread"),
  reactionId: text("reaction_id"),
  senderOpenId: text("sender_open_id"),
  connectionId: uuid("connection_id"),
  installationId: uuid("installation_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
