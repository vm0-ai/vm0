import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ChatEventSnapshotProjection } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { chatThreads } from "./chat-thread";

/**
 * Version pointers for immutable R2 Chat Event Snapshot objects. A thread has
 * at most one pointer per Chat Event schema version and projection. Updating a pointer first
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
    /** Highest physical stream position covered, including projection-omitted rows. */
    lastSeqId: bigint("last_seq_id", { mode: "number" }).notNull(),
    /** Last physical event observed through the coverage watermark. */
    lastEventId: uuid("last_event_id").notNull(),
    /** Last retained event exposed as the V7 logical cursor. */
    terminalEventId: uuid("terminal_event_id"),
    /** Sequence position paired with terminal_event_id, or zero for an empty V7 body. */
    terminalSeqId: bigint("terminal_seq_id", { mode: "number" }),
    /** Version of the NDJSON line shape inside the archive object. */
    archiveSchemaVersion: integer("archive_schema_version").notNull(),
    /** Existing pointers are the full projection; redacted pointers are explicit. */
    projection: text("projection")
      .$type<ChatEventSnapshotProjection>()
      .default("full")
      .notNull(),
    /** Multiple projections may safely reference the same content-addressed object. */
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_event_snapshots_thread_idx").on(table.chatThreadId),
      index("chat_event_snapshots_object_key_idx").on(table.objectKey),
      uniqueIndex("chat_event_snapshots_thread_version_projection_unique").on(
        table.chatThreadId,
        table.archiveSchemaVersion,
        table.projection,
      ),
      check(
        "chat_event_snapshots_projection_check",
        sql`${table.projection} IN ('full', 'tool-redacted')`,
      ),
      check(
        "chat_event_snapshots_terminal_cursor_check",
        sql`(
          ${table.archiveSchemaVersion} < 7
          AND ${table.terminalEventId} IS NULL
          AND ${table.terminalSeqId} IS NULL
        ) OR (
          ${table.archiveSchemaVersion} >= 7
          AND (
            (
              ${table.terminalEventId} IS NULL
              AND ${table.terminalSeqId} = 0
            ) OR (
              ${table.terminalEventId} IS NOT NULL
              AND ${table.terminalSeqId} > 0
              AND ${table.terminalSeqId} <= ${table.lastSeqId}
            )
          )
        )`,
      ),
      check(
        "chat_event_snapshots_canonical_projection_check",
        sql`${table.archiveSchemaVersion} < 7 OR ${table.projection} = 'tool-redacted'`,
      ),
    ];
  },
);
