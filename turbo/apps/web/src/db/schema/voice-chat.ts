import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  serial,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { agentComposes } from "./agent-compose";

/**
 * Voice-chat sessions track active voice conversations.
 * Each session has one WebRTC connection (fast-brain) and one zero agent run (slow-brain).
 *
 * Statuses: preparing → active → ended | timeout
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
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (table) => {
    return [
      index("idx_voice_chat_sessions_user").on(table.userId, table.orgId),
      index("idx_voice_chat_sessions_status").on(table.status),
      index("idx_voice_chat_sessions_user_ended_created")
        .on(table.userId, table.orgId, table.createdAt.desc())
        .where(sql`status IN ('ended', 'timeout')`),
    ];
  },
);

/**
 * Append-only event log for voice-chat shared context (blackboard pattern).
 * Both fast-brain (browser) and slow-brain (sandbox agent) read and append events.
 *
 * Sources: system | user | fast-brain | slow-brain
 * Types: session-start | session-end | speech | request-slow-brain | response |
 *        directive | thinking | observation | preparation-ready | meeting-prompt |
 *        task-dispatched | task-completed
 */
export const voiceChatEvents = pgTable(
  "voice_chat_events",
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
    source: varchar("source", { length: 20 }).notNull(),
    type: varchar("type", { length: 30 }).notNull(),
    content: text("content"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_voice_chat_events_session_seq").on(table.sessionId, table.seq),
    ];
  },
);

/**
 * Task runs dispatched by slow-brain via `zero voice-chat task create`.
 * Each row represents one short-lived Zero sandbox run kicked off from
 * `POST /api/zero/voice-chat/:id/tasks`. The row is inserted synchronously
 * before `createZeroRun` so the terminal callback can always locate it.
 *
 * Statuses: pending | queued | running | done | failed.
 * run_id is nullable (SET NULL on agent-run delete) so task history
 * survives sandbox garbage collection.
 */
export type VoiceChatTaskAssistantMessage = {
  type: "assistant";
  content: string;
  at: string;
};

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
    prompt: text("prompt").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    result: text("result"),
    error: text("error"),
    assistantMessages: jsonb("assistant_messages")
      .$type<VoiceChatTaskAssistantMessage[]>()
      .notNull()
      .default([]),
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
