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
 * Durable searchable-message projection. These rows do not depend on a
 * chat_events UUID and remain authoritative after the canonical event row
 * ages out of PostgreSQL.
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
    agentId: uuid("agent_id"),
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
      index("chat_event_search_messages_user_org_agent_id_created_idx").on(
        table.userId,
        table.orgId,
        table.agentId,
        table.createdAt.desc(),
      ),
      index("chat_event_search_messages_tsv_idx").using("gin", table.tsv),
    ];
  },
);

/**
 * Durable-projection watermark. Missing rows intentionally mean zero.
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
