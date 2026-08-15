import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

/**
 * Version pointers for immutable R2 Chat Event Snapshot objects. A thread has
 * at most one pointer per Chat Event schema version. Updating a pointer first
 * uploads a new content-addressed object, then atomically replaces the cursor
 * and object key. Snapshot refreshes reuse the stored prefix and append only
 * Raw Events after its cursor; full PostgreSQL rebuilds are valid only when a
 * thread has never had a Snapshot.
 */
export const chatEventSnapshots = pgTable(
  "chat_event_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    /** The snapshot object contains every logical thread event through this watermark. */
    lastSeqId: bigint("last_seq_id", { mode: "number" }).notNull(),
    /** Last physical event represented by the Snapshot's terminal cursor. */
    lastEventId: uuid("last_event_id").notNull(),
    /** Version of the NDJSON line shape inside the archive object. */
    archiveSchemaVersion: integer("archive_schema_version").notNull(),
    objectKey: text("object_key").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_event_snapshots_thread_idx").on(table.chatThreadId),
      uniqueIndex("chat_event_snapshots_thread_version_unique").on(
        table.chatThreadId,
        table.archiveSchemaVersion,
      ),
    ];
  },
);
