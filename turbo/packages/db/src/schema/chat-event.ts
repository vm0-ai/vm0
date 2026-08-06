import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
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
  ChatEventAttachFiles,
  ChatEventGenerationTemplate,
  ChatEventGoalEvent,
  ChatEventRecommendedFollowups,
  ChatEventUserMessage,
  ChatEventUsagePayload,
} from "@vm0/db/jsonb-contracts/chat-event";
export type {
  ChatEventAttachFileMetadata,
  ChatEventAttachFileMetadataList,
  ChatEventAttachFiles,
  ChatEventGenerationTemplate,
  ChatEventGoalEvent,
  ChatEventIllustrationGenerationTemplate,
  ChatEventPresentationGenerationTemplate,
  ChatEventRecommendedFollowup,
  ChatEventRecommendedFollowupGenerationType,
  ChatEventRecommendedFollowupKind,
  ChatEventRecommendedFollowups,
  ChatEventUserMessage,
  ChatEventUsageKindBreakdown,
  ChatEventUsagePayload,
  ChatEventUsageProviderBreakdown,
  ChatEventVideoGenerationTemplate,
  ChatEventWebsiteGenerationTemplate,
  ChatEventWorkflowGenerationTemplate,
} from "@vm0/db/jsonb-contracts/chat-event";

/**
 * Shared literal predicate for partial-index selection and ON CONFLICT
 * inference. Keep the values inline rather than parameterizing this condition.
 */
export function chatEventTerminalPredicate(eventType: SQLWrapper): SQL {
  return sql`${eventType} IN ('run.completed', 'run.failed', 'run.cancelled')`;
}

/**
 * Physical storage for the immutable ChatEvent stream.
 * Each row is one typed event belonging to a chat_thread.
 *
 * User and automation inputs are persisted immediately. A run-less,
 * unrevoked input event is pending queue state; its run-attributed replacement
 * is the immutable claim.
 *
 * Assistant rows are appended after run output exists. Queue marker control
 * rows can also be appended for queued runs and later revoked when the run
 * leaves the queue. Event-backed rows are one row per assistant-visible agent
 * output event; result-only CLI output can be projected from a terminal
 * "result" event. Failed runs append an assistant row carrying the terminal
 * error message. `run_event_sequence_number` is the upstream run-event
 * coordinate used for reconciliation and final-answer selection. The
 * deterministic primary key derived from `run_event_id` is the first
 * deduplication guard; `(run_id, run_event_sequence_number)` is a second guard.
 *
 * Terminal-state assistant rows use the `run.completed | run.failed |
 * run.cancelled` event types.
 *
 * Summaries (tool-use activity) are NOT stored here — the client fetches
 * them in real-time from the telemetry/logs endpoint for active runs.
 */
export const chatEvents = pgTable(
  "chat_events",
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
    // A null value on an unrevoked input.prompt/input.automation/input.goal is pending.
    runId: uuid("run_id"),
    usagePayload: jsonb("usage_payload").$type<ChatEventUsagePayload>(),
    revokesEventId: uuid("revokes_event_id").references(
      (): AnyPgColumn => {
        return chatEvents.id;
      },
      { onDelete: "no action" },
    ),
    interruptsRunId: uuid("interrupts_run_id"),
    // Stable grouping key for autonomous goal continuations rendered in chat.
    runGroupId: uuid("run_group_id"),
    eventType: text("event_type").$type<ChatEventType>().notNull(),
    /**
     * Input source discriminator and optional polymorphic context pointer.
     *
     * `web` and `goal` identify sources without context rows, so contextId is
     * null for those values. For other values, contextId selects the row in the
     * table named by contextType. contextId is not unique: when a pending event
     * is claimed, the revoke + insert replacement reuses it. Legal
     * (eventType, contextType) combinations are enforced by the NewChatEvent
     * TypeScript write union, not by SQL.
     */
    contextType: text("context_type").$type<
      | "web"
      | "slack"
      | "feishu"
      | "teams"
      | "telegram"
      | "github"
      | "agentphone"
      | "automation"
      | "goal"
      | "morning_brief"
      | "agent_run"
    >(),
    contextId: uuid("context_id"),
    triggerSource: text("trigger_source").$type<TriggerSource>(),
    content: text("content"),
    /** Canonical rich user-message document for user input events. */
    userMessage: jsonb("user_message").$type<ChatEventUserMessage>(),
    thinking: text("thinking"),
    error: text("error"),
    activeInputSequence: integer("active_input_sequence"),
    runEventSequenceNumber: integer("run_event_sequence_number"),
    /**
     * Upstream run-event ID or a deterministic seed for synthesized rows.
     * `queue:queued`, `queue:dequeued`, and `thinking:initial` seed stable
     * primary keys for non-agent rows. `thinking:initial` also distinguishes
     * our placeholder from real agent thinking stored in the same leaf.
     */
    runEventId: text("run_event_id"),
    /** Strictly increasing position within the owning chat thread. */
    seqId: bigint("seq_id", { mode: "number" }).notNull(),
    goalEvent: jsonb("goal_event").$type<ChatEventGoalEvent>(),
    attachFiles: jsonb("attach_files").$type<ChatEventAttachFiles>(),
    generationTemplate: jsonb(
      "generation_template",
    ).$type<ChatEventGenerationTemplate>(),
    recommendedFollowups: jsonb(
      "recommended_followups",
    ).$type<ChatEventRecommendedFollowups>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_chat_events_thread_created").on(
        table.chatThreadId,
        table.createdAt,
      ),
      index("idx_chat_events_thread_run_terminal_created")
        .on(table.chatThreadId, table.createdAt.desc())
        .where(chatEventTerminalPredicate(table.eventType)),
      index("idx_chat_events_run_id").on(table.runId),
      index("chat_events_usage_run_id_idx")
        .on(table.runId)
        .where(sql`${table.usagePayload} IS NOT NULL`),
      uniqueIndex("chat_events_revokes_event_id_not_null_unique")
        .on(table.revokesEventId)
        .where(sql`${table.revokesEventId} IS NOT NULL`),
      uniqueIndex("chat_events_interrupts_run_id_not_null_unique")
        .on(table.interruptsRunId)
        .where(sql`${table.interruptsRunId} IS NOT NULL`),
      index("chat_events_input_automation_context_idx")
        .on(table.contextId)
        .where(sql`${table.eventType} = 'input.automation'`),
      index("chat_events_pending_queue_idx")
        .on(table.chatThreadId, table.createdAt, table.id)
        .where(
          sql`${table.runId} IS NULL AND ${table.eventType} IN ('input.prompt', 'input.automation', 'input.goal')`,
        ),
      uniqueIndex("chat_events_run_event_seq_unique").on(
        table.runId,
        table.runEventSequenceNumber,
      ),
      uniqueIndex("chat_events_run_active_input_seq_unique")
        .on(table.runId, table.activeInputSequence)
        .where(sql`${table.activeInputSequence} IS NOT NULL`),
      uniqueIndex("chat_events_thread_seq_unique").on(
        table.chatThreadId,
        table.seqId,
      ),
      uniqueIndex("chat_events_run_terminal_unique")
        .on(table.runId)
        .where(chatEventTerminalPredicate(table.eventType)),
      uniqueIndex("chat_events_run_thinking_unique")
        .on(table.runId)
        .where(sql`${table.thinking} IS NOT NULL`),
      check(
        "chat_events_event_type_check",
        sql`${table.eventType} IN (
          'input.prompt',
          'input.automation',
          'input.goal',
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
          'control.interrupt',
          'control.revoke',
          'browser.started',
          'browser.stopped',
          'goal.changed',
          'usage.recorded'
        )`,
      ),
      check(
        "chat_events_input_user_message_check",
        sql`${table.eventType} NOT IN ('input.prompt', 'input.rejected')
          OR ${table.userMessage} IS NOT NULL`,
      ),
      check(
        "chat_events_input_content_check",
        sql`${table.eventType} NOT IN ('input.prompt', 'input.rejected')
          OR ${table.content} IS NULL`,
      ),
      check(
        "chat_events_context_pair_check",
        sql`${table.contextId} IS NULL OR ${table.contextType} IS NOT NULL`,
      ),
      check(
        "chat_events_context_type_check",
        sql`${table.contextType} IN (
          'web',
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'agentphone',
          'automation',
          'goal',
          'morning_brief',
          'agent_run'
        )`,
      ),
      check(
        "chat_events_input_context_type_check",
        sql`${table.eventType} NOT IN ('input.prompt', 'input.automation', 'input.goal')
          OR ${table.contextType} IS NOT NULL`,
      ),
    ];
  },
);
