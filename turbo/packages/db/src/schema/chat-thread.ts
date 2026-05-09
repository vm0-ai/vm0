import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
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
     * Kept for compatibility with existing data; new read state is derived
     * from `lastReadMessageId`.
     */
    lastReadAt: timestamp("last_read_at"),
    /**
     * ID of the latest message the user has marked read in this thread.
     * NULL means the thread has never been explicitly marked read.
     */
    lastReadMessageId: uuid("last_read_message_id"),
    /**
     * Per-thread model pin. Written at thread creation from the agent's
     * configured provider/model so subsequent runs are immune to later
     * agent-level provider changes. NULL only for legacy / default-claude-code
     * agents that have no provider configured at create time.
     *
     * Intentionally **not** a foreign key: when the referenced provider is
     * deleted, the column must retain the now-stale UUID so the run resolver
     * can detect the orphan-pinned state and surface a clear `PROVIDER_DELETED`
     * error rather than silently falling back to the agent's current provider.
     */
    modelProviderId: uuid("model_provider_id"),
    modelProviderType: varchar("model_provider_type", { length: 50 }),
    modelProviderCredentialScope: varchar("model_provider_credential_scope", {
      length: 20,
    }),
    selectedModel: varchar("selected_model", { length: 255 }),
    /**
     * Timestamp at which the user pinned this thread to the top of the sidebar.
     * NULL means unpinned. Pinned threads sort above unpinned, both groups
     * keep recency ordering. Per `(user, agent)` because `chat_threads` rows
     * already carry `user_id` + `agent_compose_id`.
     */
    pinnedAt: timestamp("pinned_at"),
    /**
     * Timestamp at which the user manually renamed this thread.
     * NULL means the thread has never been renamed.
     * When set, automated title generation is suppressed.
     */
    renamedAt: timestamp("renamed_at"),
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
      index("idx_chat_threads_user_last_read_message").on(
        table.userId,
        table.lastReadMessageId,
      ),
      index("idx_chat_threads_user_compose_pinned")
        .on(table.userId, table.agentComposeId)
        .where(sql`${table.pinnedAt} IS NOT NULL`),
    ];
  },
);
