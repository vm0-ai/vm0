import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatThreadServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import { sql } from "drizzle-orm";

export const chatThreadEventKind = pgEnum("chat_thread_event_kind", [
  "created",
  "renamed",
  "deleted",
  "pinned",
  "unpinned",
  "model_selection_updated",
  "service_tier_updated",
  "computer_use_host_updated",
  "sort_touched",
]);

export type ChatThreadEventKind =
  (typeof chatThreadEventKind.enumValues)[number];

export const chatThreadEvents = pgTable(
  "chat_thread_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    kind: chatThreadEventKind("kind").notNull(),
    agentComposeId: uuid("agent_compose_id").notNull(),
    title: text("title"),
    selectedModel: varchar("selected_model", { length: 255 }),
    serviceTier: varchar("service_tier", {
      length: 20,
    }).$type<ChatThreadServiceTier>(),
    computerUseHostId: uuid("computer_use_host_id"),
    cloudBrowserEnabled: boolean("cloud_browser_enabled")
      .default(false)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chat_thread_events_computer_access_check",
        sql`NOT (${table.cloudBrowserEnabled} AND ${table.computerUseHostId} IS NOT NULL)`,
      ),
      index("idx_chat_thread_events_user_org_created").on(
        table.userId,
        table.orgId,
        table.createdAt,
        table.id,
      ),
      index("idx_chat_thread_events_thread_created").on(
        table.chatThreadId,
        table.createdAt,
        table.id,
      ),
    ];
  },
);
