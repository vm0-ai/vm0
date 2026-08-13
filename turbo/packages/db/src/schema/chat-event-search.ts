import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

const tsvectorColumn = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
    /**
     * Mirrors chat_threads.agent_compose_id, which equals the zero agent id.
     * Projected so an agent-scoped search never has to join back to the thread.
     */
    agentComposeId: uuid("agent_compose_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /** Raw searchable text mirrored from the event. */
    text: text("text").notNull(),
    /** CJK-bigram normalized form fed to to_tsvector('simple', ...). */
    textBigram: text("text_bigram").notNull(),
    /**
     * Materialized tsvector of textBigram. Storing it keeps the parsed form on
     * the row, so an index recheck — or any plan that filters without the GIN
     * index — reads it instead of re-running to_tsvector per scanned row.
     */
    tsv: tsvectorColumn("tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', text_bigram)`,
    ),
  },
  (table) => {
    return [
      index("chat_event_search_docs_user_org_created_idx").on(
        table.userId,
        table.orgId,
        table.createdAt.desc(),
      ),
      index("chat_event_search_docs_thread_idx").on(table.chatThreadId),
      index("chat_event_search_docs_tsv_idx").using("gin", table.tsv),
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

/**
 * Durable searchable-message projection. Unlike chatEventSearchDocs, these
 * rows do not depend on a chat_events UUID and remain authoritative after the
 * canonical event row ages out of PostgreSQL.
 */
export const chatEventSearchMessages = pgTable(
  "chat_event_search_messages",
  {
    chatThreadId: uuid("chat_thread_id")
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    seqId: bigint("seq_id", { mode: "number" }).notNull(),
    runId: uuid("run_id"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentComposeId: uuid("agent_compose_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    createdAt: timestamp("created_at").notNull(),
    text: text("text").notNull(),
    textBigram: text("text_bigram").notNull(),
    tsv: tsvectorColumn("tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', text_bigram)`,
    ),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.chatThreadId, table.seqId] }),
      index("chat_event_search_messages_user_org_created_idx").on(
        table.userId,
        table.orgId,
        table.createdAt.desc(),
      ),
      index("chat_event_search_messages_user_org_agent_created_idx").on(
        table.userId,
        table.orgId,
        table.agentComposeId,
        table.createdAt.desc(),
      ),
      index("chat_event_search_messages_tsv_idx").using("gin", table.tsv),
    ];
  },
);

/**
 * Independent durable-projection watermark. Missing rows intentionally mean
 * zero so the online backfill never inherits progress from the legacy index.
 */
export const chatEventSearchMessageWatermarks = pgTable(
  "chat_event_search_message_watermarks",
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
