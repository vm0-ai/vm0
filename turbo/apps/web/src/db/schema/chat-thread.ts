import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import type { PersistedAttachment } from "@vm0/core";
import { agentComposes } from "./agent-compose";

/**
 * Chat Threads table
 * User-facing conversation thread identity, created before any run starts.
 * Provides instant sidebar entries and stable URL routing.
 * Messages are stored in the chat_messages table (1:N relationship).
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
    /**
     * Slack-style watermark: the last timestamp up to which the user has read
     * messages in this thread. Forward-only — never rewound.
     * NULL means the thread has never been explicitly marked read.
     * Used to derive `isRead` in the thread list query.
     */
    lastReadAt: timestamp("last_read_at"),
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
      index("idx_chat_threads_user_last_read").on(
        table.userId,
        table.lastReadAt,
      ),
    ];
  },
);
