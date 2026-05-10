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

/** attach_files stores only file IDs — metadata is resolved at query time. */
export type ChatMessageAttachFiles = string[];

/**
 * Chat Messages table
 * Each row is a single message belonging to a chat_thread.
 *
 * User messages are persisted immediately on send. Queued user messages have no
 * run_id; when the queue is drained, a new user row is appended with run_id and
 * revokes_message_id pointing at the queued row it supersedes.
 *
 * Assistant rows are appended after run output exists. Event-backed rows are
 * one row per assistant-visible agent output event; result-only CLI output can
 * be projected from a terminal "result" event. Failed runs append an assistant
 * row carrying the terminal error message. Event-backed rows are keyed by
 * `(run_id, sequence_number)` for idempotent, lock-free inserts from both the
 * event consumer and the callback's final sweep.
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
    sequenceNumber: integer("sequence_number"),
    runEventId: text("run_event_id"), // Anthropic message ID from event.message.id (e.g. "msg_01abc...")
    attachFiles: jsonb("attach_files").$type<ChatMessageAttachFiles>(),
    /**
     * Goal-mode columns. NULL on every non-goal message.
     *
     * `goalRemainingTurns` is inclusive of the current turn — when it equals
     * 1, this is the last turn of the goal chain. `goalOriginMessageId` points
     * to the original `/go` row of the chain (the origin row points to itself).
     */
    goalRemainingTurns: integer("goal_remaining_turns"),
    goalOriginMessageId: uuid("goal_origin_message_id").references(
      (): AnyPgColumn => {
        return chatMessages.id;
      },
      { onDelete: "set null" },
    ),
    /**
     * Idempotency key for goal continuation rows. Set to the id of the
     * just-completed run that the continuation was inserted in response to.
     * `chat_messages_goal_continuation_run_unique` ensures at-least-once
     * callback delivery cannot produce two continuation rows for the same
     * source run — the second insert hits the constraint and `onConflictDoNothing`
     * turns it into a no-op.
     */
    goalContinuationOfRunId: uuid("goal_continuation_of_run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at"),
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
      index("idx_chat_messages_goal_origin").on(table.goalOriginMessageId),
      uniqueIndex("chat_messages_goal_continuation_run_unique").on(
        table.goalContinuationOfRunId,
      ),
    ];
  },
);
