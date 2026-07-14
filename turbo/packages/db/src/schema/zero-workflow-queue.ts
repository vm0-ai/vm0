import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { zeroWorkflowAutomations, zeroWorkflows } from "./zero-workflow";

/**
 * Pending workflow trigger events.
 *
 * With the workflow queue enabled, a workflow(+owner user) executes at most
 * one trigger run at a time. Events that fire while the workflow is busy (or
 * while its queue is paused) wait here and are consumed FIFO when the
 * in-flight run reaches a terminal status. Rows are deleted after dequeue,
 * mirroring agent_run_queue.
 */
export const zeroWorkflowQueueEvents = pgTable(
  "zero_workflow_queue_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    triggerSource: text("trigger_source").notNull(),
    // Short human-readable event summary, safe to render in the queue UI.
    triggerBrief: text("trigger_brief"),
    // Persistent-secret encrypted remainder of the trigger run args
    // (prompt / appendSystemPrompt / callbacks). appendSystemPrompt may carry
    // external event content such as webhook bodies, so it stays encrypted.
    encryptedParams: text("encrypted_params").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // FIFO dequeue within one workflow queue (org + owner user + workflow).
      index("idx_zero_workflow_queue_events_fifo").on(
        table.orgId,
        table.userId,
        table.workflowId,
        table.createdAt,
      ),
      // Per-trigger lookups: schedule tick coalescing and source display.
      index("idx_zero_workflow_queue_events_trigger").on(table.triggerId),
      // Queue reads for the thread-scoped API and drain sweep.
      index("idx_zero_workflow_queue_events_chat_thread").on(
        table.chatThreadId,
      ),
    ];
  },
);
