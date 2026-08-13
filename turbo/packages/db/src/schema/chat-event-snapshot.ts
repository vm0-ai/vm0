import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

/**
 * Version pointers for immutable R2 Chat Event Snapshot objects. A thread has
 * at most one pointer per Chat Event schema version. Updating a pointer first
 * uploads a new content-addressed object, then atomically replaces the cursor
 * and object key. Snapshot refreshes reuse the stored prefix and append only
 * Raw Events after its cursor; full PostgreSQL rebuilds are valid only when a
 * thread has never had a Snapshot.
 *
 * is_head and parent_snapshot_id are retained for deployment compatibility but
 * are not reader identity. The (thread, schema version) key owns that role.
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
    parentSnapshotId: uuid("parent_snapshot_id").references(
      (): AnyPgColumn => {
        return chatEventSnapshots.id;
      },
      { onDelete: "set null" },
    ),
    /** The snapshot object contains every thread event with seq_id <= this. */
    lastSeqId: bigint("last_seq_id", { mode: "number" }).notNull(),
    /** Last physical event represented by the Snapshot's terminal cursor. */
    lastEventId: uuid("last_event_id").notNull(),
    /** Version of the NDJSON line shape inside the archive object. */
    archiveSchemaVersion: integer("archive_schema_version").notNull(),
    objectKey: text("object_key").notNull().unique(),
    isHead: boolean("is_head").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("chat_event_snapshots_thread_head_unique")
        .on(table.chatThreadId)
        .where(sql`${table.isHead}`),
      index("chat_event_snapshots_thread_idx").on(table.chatThreadId),
      uniqueIndex("chat_event_snapshots_thread_version_unique").on(
        table.chatThreadId,
        table.archiveSchemaVersion,
      ),
    ];
  },
);
