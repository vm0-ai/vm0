import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  uniqueIndex,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";
import { agentRuns } from "./agent-run";

/** attach_files stores legacy file IDs. */
export type ChatMessageAttachFiles = string[];

export interface ChatMessageAttachFileMetadata {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly objectKey: string;
}

export type ChatMessageAttachFileMetadataList = ChatMessageAttachFileMetadata[];

/**
 * Chat Messages table
 * Each row is a single message belonging to a chat_thread.
 *
 * User messages are persisted immediately on send. Queued user messages have no
 * run_id; when the queue is drained, a new user row is appended with run_id and
 * revokes_message_id pointing at the queued row it supersedes.
 *
 * Assistant rows are appended after run output exists. Queue marker control
 * rows can also be appended for queued runs and later revoked when the run
 * leaves the queue. Event-backed rows are one row per assistant-visible agent
 * output event; result-only CLI output can be projected from a terminal
 * "result" event. Failed runs append an assistant row carrying the terminal
 * error message. Event-backed rows are keyed by `(run_id, sequence_number)` for
 * idempotent, lock-free inserts from both the event consumer and the callback's
 * final sweep.
 *
 * Terminal-state assistant rows carry `run_lifecycle_event` set to one of
 * `completed | failed | cancelled`. Exactly one such row exists per `run_id`;
 * the indicator and dim finish line are derived from this row.
 *
 * Summaries (tool-use activity) are NOT stored here — the client fetches
 * them in real-time from the telemetry/logs endpoint for active runs.
 */
export const chatMessages = pgTable(
  "chat_messages",
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
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    revokesMessageId: uuid("revokes_message_id").references(
      (): AnyPgColumn => {
        return chatMessages.id;
      },
      { onDelete: "set null" },
    ),
    interruptsRunId: uuid("interrupts_run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    role: text("role").notNull(), // "user" | "assistant"
    content: text("content"),
    error: text("error"),
    /** "completed" | "failed" | "cancelled"; null for non-terminal rows. */
    runLifecycleEvent: text("run_lifecycle_event"),
    sequenceNumber: integer("sequence_number"),
    runEventId: text("run_event_id"), // Anthropic message ID from event.message.id (e.g. "msg_01abc...")
    attachFiles: jsonb("attach_files").$type<ChatMessageAttachFiles>(),
    attachFileMetadata: jsonb(
      "attach_file_metadata",
    ).$type<ChatMessageAttachFileMetadataList>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_chat_messages_thread_created").on(
        table.chatThreadId,
        table.createdAt,
      ),
      index("idx_chat_messages_run_id").on(table.runId),
      uniqueIndex("chat_messages_revokes_message_id_unique").on(
        table.revokesMessageId,
      ),
      uniqueIndex("chat_messages_interrupts_run_id_unique").on(
        table.interruptsRunId,
      ),
      uniqueIndex("chat_messages_run_seq_unique").on(
        table.runId,
        table.sequenceNumber,
      ),
      uniqueIndex("chat_messages_run_lifecycle_unique")
        .on(table.runId)
        .where(sql`${table.runLifecycleEvent} IS NOT NULL`),
    ];
  },
);
