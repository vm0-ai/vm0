import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PiThreadMessagePayload } from "@vm0/db/jsonb-contracts/pi-thread-message";
import { chatThreads } from "./chat-thread";

/**
 * Pi thread transcript messages.
 *
 * Append-only model transcript for Pi chat threads: one row per completed Pi
 * message (user, assistant, or tool result). The latest `version` is the
 * canonical transcript; version bumps are reserved for future compaction.
 * Appends are guarded by a tail compare-and-swap, so ordinals stay contiguous
 * within a version.
 */
export const piThreadMessages = pgTable(
  "pi_thread_messages",
  {
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    version: integer("version").notNull(),
    ordinal: integer("ordinal").notNull(),
    // Attribution and resume coordination only — runs can be pruned while the
    // thread transcript lives on, so this deliberately has no foreign key.
    runId: uuid("run_id").notNull(),
    // Run-global agent event sequence that delivered this message.
    runEventSequenceNumber: integer("run_event_sequence_number").notNull(),
    messageId: text("message_id").notNull(),
    role: text("role").notNull(),
    payload: jsonb("payload").$type<PiThreadMessagePayload>().notNull(),
    // SHA-256 hex of the canonical payload JSON; replayed deliveries must match.
    payloadHash: text("payload_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.chatThreadId, table.version, table.ordinal],
      }),
      uniqueIndex("pi_thread_messages_message_id_unique").on(
        table.chatThreadId,
        table.messageId,
      ),
      uniqueIndex("pi_thread_messages_run_event_seq_unique").on(
        table.runId,
        table.runEventSequenceNumber,
      ),
    ];
  },
);
