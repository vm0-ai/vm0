import type {
  ChatSlackMentionDisplayNames,
  ChatSlackMessageFiles,
} from "@vm0/db/jsonb-contracts/chat-slack-context";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  messagePermalink: text("message_permalink"),
  channelId: text("channel_id"),
  messageTs: text("message_ts"),
  /**
   * Server-private Slack launch material retained with the trigger context.
   * Raw third-party content is intentionally retained permanently; read paths
   * must continue to project only the explicitly required columns.
   */
  conversationContext: text("conversation_context"),
  messageText: text("message_text"),
  messageFiles: jsonb("message_files").$type<ChatSlackMessageFiles>(),
  mentionDisplayNames: jsonb(
    "mention_display_names",
  ).$type<ChatSlackMentionDisplayNames>(),
  senderDisplayName: text("sender_display_name"),
  senderUserId: text("sender_user_id"),
  channelType: text("channel_type").$type<"channel" | "dm" | "group_dm">(),
  threadTs: text("thread_ts"),
  routeThreadTs: text("route_thread_ts"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
