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
 * Immutable R2 archive facts for the chat_events stream: one row per uploaded
 * full-thread snapshot object. Every snapshot covers seq_id (0, last_seq_id]
 * of its thread, so readers only ever need the head row plus the Postgres
 * tail. parent_snapshot_id records which snapshot object the archiver
 * replayed while building this one; a null parent is a first-generation
 * snapshot built entirely from Postgres. The object key embeds the gzip
 * content sha256, which makes objects content-addressed and lets readers
 * verify downloads without extra columns.
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
    ];
  },
);
