import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import type { VoiceChatTaskResultEntry } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { agentComposes } from "./agent-compose";
import { agentRuns } from "./agent-run";

/**
 * Voice-chat-candidate sessions. Same shape as voiceChatSessions but stored
 * in a separate table so candidate experiments don't interfere with
 * production voice-chat data.
 */
export const voiceChatCandidateSessions = pgTable(
  "voice_chat_candidate_sessions",
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
    mode: varchar("mode", { length: 20 }).notNull().default("chat"),
    conversationSummary: text("conversation_summary"),
    workingTasksSummary: text("working_tasks_summary"),
    finishedTasksSummary: text("finished_tasks_summary"),
    summarySeq: integer("summary_seq").notNull().default(0),
    summaryVersion: integer("summary_version").notNull().default(0),
    lastSummaryAt: timestamp("last_summary_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_vc_candidate_sessions_user").on(table.userId, table.orgId),
      index("idx_vc_candidate_sessions_user_agent_created").on(
        table.userId,
        table.agentId,
        table.createdAt,
      ),
    ];
  },
);

/**
 * Task Run entries for voice-chat-candidate sessions. Same shape as
 * voiceChatTasks but stored separately.
 */
export const voiceChatCandidateTasks = pgTable(
  "voice_chat_candidate_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(
        () => {
          return voiceChatCandidateSessions.id;
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
    status: varchar("status", { length: 20 }).notNull(),
    result: text("result"),
    resultUpdatedAt: timestamp("result_updated_at"),
    assistantMessages: jsonb("assistant_messages")
      .$type<VoiceChatTaskResultEntry[]>()
      .notNull()
      .default([]),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => {
    return [
      index("idx_vc_candidate_tasks_session_status_created").on(
        table.sessionId,
        table.status,
        table.createdAt,
      ),
    ];
  },
);
