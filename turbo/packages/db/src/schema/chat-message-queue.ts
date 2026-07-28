import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { chatMessages } from "./chat-message";
import { chatThreads } from "./chat-thread";
import { zeroWorkflowAutomations } from "./zero-workflow";

export const chatMessageQueueItemType = pgEnum("chat_message_queue_item_type", [
  "user_message",
  "slack_user_message",
  "feishu_user_message",
  "teams_user_message",
  "workflow_event",
]);

/**
 * Legacy pending queue items retained for the cutover migration.
 *
 * Current runtime admission and drain no longer use this table. The cutover
 * migration converts existing rows and installs temporary database triggers
 * that mirror writes from the previous API during traffic promotion. Current
 * claims remove any mirrored legacy pointer; Phase 2 cleanup removes the
 * triggers and physical schema after old writers have drained.
 *
 * Payload placement is per item type:
 * - `user_message` / `slack_user_message` / `feishu_user_message` /
 *   `teams_user_message`: the message body lives in `chat_messages`
 *   (`chat_message_id` points at it); the queue row only carries the queued
 *   state.
 * - `workflow_event`: the row carries the automation event itself
 *   (`automation_id` / `trigger_source` / `trigger_brief` / `encrypted_params`)
 *   and materializes into a chat message at claim time.
 *
 * The columns remain modeled so test-state and the one-time cutover can
 * classify the legacy payload exactly.
 */
export const chatMessageQueue = pgTable(
  "chat_message_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    itemType: chatMessageQueueItemType("item_type").notNull(),
    // User-message payload: the queued chat_messages row.
    chatMessageId: uuid("chat_message_id").references(
      () => {
        return chatMessages.id;
      },
      { onDelete: "cascade" },
    ),
    // workflow_event payload. Automation deletion cascades here, which also
    // covers workflow deletion (automations cascade from workflows).
    automationId: uuid("automation_id").references(
      () => {
        return zeroWorkflowAutomations.id;
      },
      { onDelete: "cascade" },
    ),
    triggerSource: text("trigger_source"),
    // Short human-readable event summary, safe to render in the queue UI.
    triggerBrief: text("trigger_brief"),
    // Persistent-secret encrypted remainder of the trigger run args
    // (prompt / appendSystemPrompt / callbacks). Callbacks carry secrets,
    // so the payload stays encrypted.
    encryptedParams: text("encrypted_params"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Priority + FIFO dequeue within one thread queue.
      index("idx_chat_message_queue_thread_created").on(
        table.chatThreadId,
        table.createdAt,
      ),
      // Per-automation lookups: schedule tick coalescing and source display.
      index("idx_chat_message_queue_automation")
        .on(table.automationId)
        .where(sql`${table.automationId} IS NOT NULL`),
    ];
  },
);
