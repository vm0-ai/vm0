import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { slackOrgConnections } from "./slack-org-connection";

/**
 * Sticky canonical chat ownership for one VM0 user's view of a physical Slack
 * thread.
 */
export const slackChatThreadRoutes = pgTable(
  "slack_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return slackOrgConnections.id;
        },
        { onDelete: "cascade" },
      ),
    channelId: varchar("channel_id", { length: 255 }).notNull(),
    threadTs: varchar("thread_ts", { length: 255 }).notNull(),
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
      uniqueIndex("idx_slack_chat_thread_routes_conn_channel_thread_user").on(
        table.connectionId,
        table.channelId,
        table.threadTs,
        table.userId,
      ),
    ];
  },
);
