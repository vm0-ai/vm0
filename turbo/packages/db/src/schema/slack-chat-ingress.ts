import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { slackChatThreadRoutes } from "./slack-chat-thread-route";

export type SlackChatIngressStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed";

/**
 * Durable admission record for canonical Slack events. Slack retries reuse the
 * same event ID, so this table is the canonical path's deduplication boundary.
 */
export const slackChatIngress = pgTable(
  "slack_chat_ingress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    routeId: uuid("route_id")
      .notNull()
      .references(
        () => {
          return slackChatThreadRoutes.id;
        },
        { onDelete: "cascade" },
      ),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    payload: text("payload").notNull(),
    status: varchar("status", { length: 16 })
      .$type<SlackChatIngressStatus>()
      .default("pending")
      .notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_slack_chat_ingress_event_id").on(table.eventId),
      check(
        "chk_slack_chat_ingress_status",
        sql`${table.status} IN ('pending', 'processing', 'processed', 'failed')`,
      ),
      check(
        "chk_slack_chat_ingress_retry_count",
        sql`${table.retryCount} >= 0`,
      ),
    ];
  },
);
