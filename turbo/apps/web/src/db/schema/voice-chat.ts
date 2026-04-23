import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  serial,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { VoiceChatCandidateTaskResultEntry } from "@vm0/core/contracts/zero-voice-chat-candidate";
import { agentComposes } from "./agent-compose";
import { agentRuns } from "./agent-run";

/**
 * Voice-chat sessions backing the Reasoner-based three-component
 * architecture (Talker / Reasoner / Task Run).
 *
 * Modes: chat (only supported value in v1 — meeting mode is out of scope).
 * Statuses: active → ended | timeout.
 * Reasoning statuses: idle | running — used with `reasoning_pending` for
 * the single-owner CAS lock that guards Reasoner tick concurrency.
 */
export const voiceChatSessions = pgTable(
  "voice_chat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").references(
      () => {
        return agentComposes.id;
      },
      { onDelete: "set null" },
    ),
    // Valid values: "chat" (v1 only)
    mode: varchar("mode", { length: 20 }).notNull().default("chat"),
    conversationSummary: text("conversation_summary"),
    workingTasksSummary: text("working_tasks_summary"),
    finishedTasksSummary: text("finished_tasks_summary"),
    summarySeq: integer("summary_seq").notNull().default(0),
    summaryVersion: integer("summary_version").notNull().default(0),
    // Valid values: "idle" | "running"
    reasoningStatus: varchar("reasoning_status", { length: 20 })
      .notNull()
      .default("idle"),
    reasoningPending: boolean("reasoning_pending").notNull().default(false),
    lastSummaryAt: timestamp("last_summary_at"),
    // Set when the current reasoner tick wins the CAS lock; cleared to
    // current timestamp on release. Use together with lastReasoningDurationMs
    // to diagnose "why is the reasoner slow".
    lastReasoningStartedAt: timestamp("last_reasoning_started_at"),
    lastReasoningDurationMs: integer("last_reasoning_duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_voice_chat_sessions_user").on(table.userId, table.orgId),
      // Supports the "latest session for (userId, agentId)" lookup performed
      // by createVoiceChatCandidateSession (get-or-create).
      index("idx_voice_chat_sessions_user_agent_created").on(
        table.userId,
        table.agentId,
        table.createdAt,
      ),
    ];
  },
);

/**
 * Append-only conversation log for voice-chat sessions.
 *
 * Roles: user | assistant — browser-originated transcript turns.
 *        task_result — appended by the Task Run callback.
 *        system_note — server-side annotations (e.g. session events).
 *
 * `realtime_item_id` is the client-supplied dedupe key for browser items;
 * it is NULL for server-written rows (task_result, system_note). The
 * unique index is NULL-tolerant by Postgres default, so multiple server
 * rows with NULL id coexist while browser duplicates are rejected.
 */
export const voiceChatItems = pgTable(
  "voice_chat_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(
        () => {
          return voiceChatSessions.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    seq: serial("seq").notNull(),
    // Valid values: "user" | "assistant" | "task_result" | "system_note"
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content"),
    taskId: uuid("task_id"),
    realtimeItemId: text("realtime_item_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_voice_chat_items_session_seq").on(table.sessionId, table.seq),
      uniqueIndex("uq_voice_chat_items_session_realtime").on(
        table.sessionId,
        table.realtimeItemId,
      ),
    ];
  },
);

/**
 * Task Run entries created by the Talker via `createTask({ prompt })`.
 * Each row represents one short-lived CC execution dispatched by
 * `createZeroRun`. The row is inserted synchronously before the run is
 * created, so the callback can always locate the task by `call_id`.
 */
export const voiceChatTasks = pgTable(
  "voice_chat_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(
        () => {
          return voiceChatSessions.id;
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
    callId: text("call_id").notNull(),
    prompt: text("prompt").notNull(),
    // Valid values: "pending" | "queued" | "running" | "done" | "failed"
    status: varchar("status", { length: 20 }).notNull(),
    // Consolidated final result. Populated on task completion with the full
    // text, then periodically compacted by the Reasoner tick.
    result: text("result"),
    // Last time `result` was written (either on completion or a compaction
    // pass). NULL while the task is in-flight.
    resultUpdatedAt: timestamp("result_updated_at"),
    assistantMessages: jsonb("assistant_messages")
      .$type<VoiceChatCandidateTaskResultEntry[]>()
      .notNull()
      .default([]),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => {
    return [
      index("idx_voice_chat_tasks_session_status_created").on(
        table.sessionId,
        table.status,
        table.createdAt,
      ),
    ];
  },
);
