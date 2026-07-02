import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const chatThreadEventKind = pgEnum("chat_thread_event_kind", [
  "created",
  "renamed",
  "deleted",
  "pinned",
  "unpinned",
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
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
