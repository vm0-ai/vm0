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
  "workflow_event",
]);

/**
 * Pending queue items for a chat thread.
 *
 * A chat thread executes at most one run at a time; everything else waits
 * here and is consumed by priority (user messages before `workflow_event`)
 * then FIFO. Rows are deleted after dequeue, mirroring agent_run_queue.
 *
 * Payload placement is per item type:
 * - `user_message` / `slack_user_message`: the message body lives in `chat_messages`
 *   (`chat_message_id` points at it); the queue row only carries the
 *   queued state.
 * - `workflow_event`: the row carries the automation event itself
 *   (`automation_id` / `trigger_source` / `trigger_brief` / `encrypted_params`)
 *   and materializes into a chat message at claim time.
 *
 * Replaces the dropped `zero_workflow_queue_events` table (FIFO key was
 * org + user + workflow; the workflow-user maps 1:1 to a chat thread, so
 * keying by thread is equivalent). This table is also the sole source of
 * queued-user-message state; `chat_messages.run_id` is attribution only.
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
    // user_message / slack_user_message payload: the queued chat_messages row.
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
    // Original ingress start retained until queued work creates its run.
    apiStartedAt: timestamp("api_started_at"),
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
