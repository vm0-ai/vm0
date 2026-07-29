import {
  bigint,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ChatThreadSnapshotProjections } from "@vm0/db/jsonb-contracts/chat-thread-snapshot";
export type { ChatThreadSnapshotProjection } from "@vm0/db/jsonb-contracts/chat-thread-snapshot";

export const chatThreadSnapshots = pgTable(
  "chat_thread_snapshots",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    latestEventId: uuid("latest_event_id"),
    /** Sequence position represented by the compacted snapshot. */
    latestEventSeqId: bigint("latest_event_seq_id", { mode: "number" }),
    chatThreads: jsonb("chat_threads")
      .$type<ChatThreadSnapshotProjections>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);
