import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import type { PersistedAttachment } from "@vm0/core";
import { agentComposes } from "./agent-compose";
import { agentRuns } from "./agent-run";
import { agentSessions } from "./agent-session";

/**
 * Chat Threads table
 * User-facing conversation thread identity, created before any run starts.
 * Provides instant sidebar entries and stable URL routing.
 */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    agentComposeId: uuid("agent_compose_id")
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    title: text("title"),
    sessionId: uuid("session_id").references(
      () => {
        return agentSessions.id;
      },
      {
        onDelete: "set null",
      },
    ),
    /**
     * ID of the scheduled agent run this thread was started from, if any.
     * When set, the first run created in this thread is seeded with a system
     * prompt that instructs the agent to fetch the original run's telemetry
     * via `zero logs <id>` in its sandbox. Subsequent runs reuse the resulting
     * session context, so the prompt is only applied once.
     */
    sourceScheduleRunId: uuid("source_schedule_run_id"),
    /**
     * Draft text content for the thread's composer. Null when no draft is saved.
     * Persisted with local-first sync: local state takes precedence on first visit.
     */
    draftContent: text("draft_content"),
    /**
     * Draft attachment metadata for the thread's composer. Only completed uploads.
     * Null when no draft attachments are saved.
     */
    draftAttachments: jsonb("draft_attachments").$type<PersistedAttachment[]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_chat_threads_user_compose_updated").on(
        table.userId,
        table.agentComposeId,
        table.updatedAt.desc(),
      ),
    ];
  },
);

/**
 * Chat Thread Runs join table
 * Associates chat threads with agent runs (many-to-many).
 */
export const chatThreadRuns = pgTable(
  "chat_thread_runs",
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
    runId: uuid("run_id")
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_chat_thread_runs_unique").on(
        table.chatThreadId,
        table.runId,
      ),
      index("idx_chat_thread_runs_thread").on(table.chatThreadId),
    ];
  },
);
