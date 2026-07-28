import { sql } from "drizzle-orm";
import type { ChatEventType } from "@vm0/api-contracts/contracts/chat-events";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import {
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  bigint,
  uniqueIndex,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";
import type {
  ChatMessageAttachFileMetadataList,
  ChatMessageAttachFiles,
  ChatMessageGenerationTemplate,
  ChatMessageGoalEvent,
  ChatMessageGoalSnapshot,
  ChatMessageRecommendedFollowups,
  ChatMessageStructuredPrompt,
  ChatMessageUsagePayload,
} from "@vm0/db/jsonb-contracts/chat-message";
export type {
  ChatMessageAttachFileMetadata,
  ChatMessageAttachFileMetadataList,
  ChatMessageAttachFiles,
  ChatMessageGenerationTemplate,
  ChatMessageGoalEvent,
  ChatMessageGoalSnapshot,
  ChatMessageIllustrationGenerationTemplate,
  ChatMessagePresentationGenerationTemplate,
  ChatMessageRecommendedFollowup,
  ChatMessageRecommendedFollowupGenerationType,
  ChatMessageRecommendedFollowupKind,
  ChatMessageRecommendedFollowups,
  ChatMessageStructuredPrompt,
  ChatMessageUsageKindBreakdown,
  ChatMessageUsagePayload,
  ChatMessageUsageProviderBreakdown,
  ChatMessageVideoGenerationTemplate,
  ChatMessageWebsiteGenerationTemplate,
  ChatMessageWorkflowGenerationTemplate,
} from "@vm0/db/jsonb-contracts/chat-message";

/**
 * Physical storage for the immutable ChatEvent stream.
 * Each row is one typed event belonging to a chat_thread. The table and
 * selected physical column names stay message-named during the rollout.
 *
 * User messages are persisted immediately on send. Until the queue writer
 * cutover, queued state remains represented by chat_message_queue rows. The
 * nullable automation payload columns prepare readers for pending events
 * without changing the active writer path in this release.
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
    // Attribution only: identifies the run that consumed or produced this row.
    // Queued state is represented exclusively by chat_message_queue.
    runId: uuid("run_id"),
    usagePayload: jsonb("usage_payload").$type<ChatMessageUsagePayload>(),
    revokesEventId: uuid("revokes_message_id").references(
      (): AnyPgColumn => {
        return chatMessages.id;
      },
      { onDelete: "no action" },
    ),
    interruptsRunId: uuid("interrupts_run_id"),
    // Stable grouping key for repeated automation/workflow/goal-triggered
    // runs rendered in a chat thread.
    runGroupId: uuid("run_group_id"),
    eventType: text("event_type").$type<ChatEventType>().notNull(),
    automationId: uuid("automation_id"),
    triggerSource: text("trigger_source").$type<TriggerSource>(),
    triggerBrief: text("trigger_brief"),
    // Persistent-secret encrypted queue parameters. This field never leaves
    // the API and is populated only by a later writer cutover.
    encryptedParams: text("encrypted_params"),
    role: text("role").notNull(), // "user" | "assistant"
    content: text("content"),
    /** Stable business representation of rich user-message content. */
    structuredPrompt:
      jsonb("structured_prompt").$type<ChatMessageStructuredPrompt>(),
    /**
     * Full structured content for rollout-only parts that older API versions
     * cannot decode. The legacy column remains a safe projection so an older
     * API can continue reading messages during a rollback.
     */
    structuredPromptWithFeedback: jsonb(
      "structured_prompt_with_feedback",
    ).$type<ChatMessageStructuredPrompt>(),
    thinking: text("thinking"),
    error: text("error"),
    /** "completed" | "failed" | "cancelled"; null for non-terminal rows. */
    runLifecycleEvent: text("run_lifecycle_event"),
    sequenceNumber: integer("sequence_number"),
    runEventId: text("run_event_id"), // Anthropic message ID from event.message.id (e.g. "msg_01abc...")
    /** Strictly increasing position within the owning chat thread. */
    seqId: bigint("seq_id", { mode: "number" }).notNull(),
    goalEvent: jsonb("goal_event").$type<ChatMessageGoalEvent>(),
    goalSnapshot: jsonb("goal_snapshot").$type<ChatMessageGoalSnapshot>(),
    attachFiles: jsonb("attach_files").$type<ChatMessageAttachFiles>(),
    attachFileMetadata: jsonb(
      "attach_file_metadata",
    ).$type<ChatMessageAttachFileMetadataList>(),
    generationTemplate: jsonb(
      "generation_template",
    ).$type<ChatMessageGenerationTemplate>(),
    slackMessagePermalink: text("slack_message_permalink"),
    feishuChatOpenUrl: text("feishu_chat_open_url"),
    recommendedFollowups: jsonb(
      "recommended_followups",
    ).$type<ChatMessageRecommendedFollowups>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_chat_messages_thread_created").on(
        table.chatThreadId,
        table.createdAt,
      ),
      index("idx_chat_messages_thread_run_finish_created")
        .on(table.chatThreadId, table.createdAt.desc())
        .where(sql`${table.runLifecycleEvent} IS NOT NULL`),
      index("idx_chat_messages_run_id").on(table.runId),
      index("chat_messages_usage_run_id_idx")
        .on(table.runId)
        .where(sql`${table.usagePayload} IS NOT NULL`),
      uniqueIndex("chat_messages_revokes_message_id_unique").on(
        table.revokesEventId,
      ),
      uniqueIndex("chat_messages_interrupts_run_id_unique").on(
        table.interruptsRunId,
      ),
      index("idx_chat_messages_run_group_id")
        .on(table.runGroupId)
        .where(sql`${table.runGroupId} IS NOT NULL`),
      index("chat_messages_input_automation_idx")
        .on(table.automationId)
        .where(sql`${table.eventType} = 'input.automation'`),
      index("chat_messages_pending_queue_idx")
        .on(table.chatThreadId, table.createdAt, table.id)
        .where(
          sql`${table.runId} IS NULL AND ${table.eventType} IN ('input.prompt', 'input.automation')`,
        ),
      index("chat_messages_automation_pause_idx")
        .on(table.chatThreadId, table.seqId.desc())
        .where(
          sql`${table.eventType} IN ('queue.automation_paused', 'queue.automation_resumed')`,
        ),
      uniqueIndex("chat_messages_run_seq_unique").on(
        table.runId,
        table.sequenceNumber,
      ),
      uniqueIndex("chat_messages_thread_seq_unique").on(
        table.chatThreadId,
        table.seqId,
      ),
      uniqueIndex("chat_messages_run_lifecycle_unique")
        .on(table.runId)
        .where(sql`${table.runLifecycleEvent} IS NOT NULL`),
      uniqueIndex("chat_messages_run_thinking_unique")
        .on(table.runId)
        .where(sql`${table.thinking} IS NOT NULL`),
      check(
        "chat_messages_event_type_check",
        sql`${table.eventType} IN (
          'input.prompt',
          'input.automation',
          'input.rejected',
          'output.message',
          'output.error',
          'output.thinking',
          'output.followups',
          'run.queued',
          'run.dequeued',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'queue.automation_paused',
          'queue.automation_resumed',
          'control.interrupt',
          'control.revoke',
          'goal.changed',
          'usage.recorded'
        )`,
      ),
    ];
  },
);
