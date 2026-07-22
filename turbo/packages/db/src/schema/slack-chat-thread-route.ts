import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { slackOrgConnections } from "./slack-org-connection";

export type SlackChatThreadRouteBackend = "legacy" | "canonical";

/**
 * Sticky backend ownership for one VM0 user's view of a physical Slack thread.
 * Runtime routing lands separately; this table is the adapter-owned routing
 * source of truth shared by the legacy and canonical paths.
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
    backend: varchar("backend", { length: 16 })
      .$type<SlackChatThreadRouteBackend>()
      .notNull(),
    chatThreadId: uuid("chat_thread_id").references(
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
      check(
        "chk_slack_chat_thread_routes_backend_thread",
        sql`(${table.backend} = 'legacy' AND ${table.chatThreadId} IS NULL)
          OR (${table.backend} = 'canonical' AND ${table.chatThreadId} IS NOT NULL)`,
      ),
    ];
  },
);
