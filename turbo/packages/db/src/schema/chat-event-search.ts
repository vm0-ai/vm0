import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

/**
 * Search projection over the canonical chat_events stream: one row per
 * searchable user prompt or assistant message. Rows are derived data — the
 * search projector cron rebuilds them from chat_events, so this table can be
 * dropped and replayed without data loss.
 */
export const chatEventSearchDocs = pgTable(
  "chat_event_search_docs",
  {
    /** Mirrors chat_events.id, which makes projection upserts idempotent. */
    eventId: uuid("event_id").primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /** Raw searchable text, also used for fallback ILIKE matching. */
    text: text("text").notNull(),
    /** CJK-bigram normalized form fed to to_tsvector('simple', ...). */
    textBigram: text("text_bigram").notNull(),
  },
  (table) => {
    return [
      index("chat_event_search_docs_user_org_created_idx").on(
        table.userId,
        table.orgId,
        table.createdAt.desc(),
      ),
      index("chat_event_search_docs_thread_idx").on(table.chatThreadId),
      index("chat_event_search_docs_tsv_idx").using(
        "gin",
        sql`to_tsvector('simple', ${table.textBigram})`,
      ),
    ];
  },
);

/**
 * Per-thread projection watermark: chat_events with seq_id <=
 * indexed_seq_id are reflected in chat_event_search_docs.
 */
export const chatEventSearchWatermarks = pgTable(
  "chat_event_search_watermarks",
  {
    chatThreadId: uuid("chat_thread_id")
      .primaryKey()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    indexedSeqId: bigint("indexed_seq_id", { mode: "number" }).notNull(),
  },
);
