import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentComposes, agentComposeVersions } from "./agent-compose";
import type { ContextArtifact } from "../types";

/**
 * Agent Runs table
 * Created when developer executes agent via SDK
 * References immutable compose version for reproducibility
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID - owner of this run
    agentComposeVersionId: varchar("agent_compose_version_id", {
      length: 64,
    }).references(
      () => {
        return agentComposeVersions.id;
      },
      { onDelete: "set null" },
    ),
    resumedFromCheckpointId: uuid("resumed_from_checkpoint_id"),
    continuedFromSessionId: uuid("continued_from_session_id"),
    sessionId: uuid("session_id")
      .notNull()
      .references(
        (): AnyPgColumn => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 20 }).notNull(),
    prompt: text("prompt").notNull(),
    appendSystemPrompt: text("append_system_prompt"),
    vars: jsonb("vars"),
    // Secret names for validation (values never stored - must be provided at runtime)
    secretNames: jsonb("secret_names").$type<string[]>(),
    // Additional volumes passed at run time (name, version, mountPath for checkpoint restore)
    additionalVolumes: jsonb("additional_volumes").$type<
      Array<{
        name: string;
        version?: string;
        mountPath: string;
        system?: boolean;
      }>
    >(),
    sandboxId: varchar("sandbox_id", { length: 255 }),
    // One of: "reused" | "featureDisabled" | "noSessionId" | "poolMiss" |
    // "profileMismatch" | "unparkFailed". Null means unknown (old runner or
    // historical row).
    sandboxReuseResult: varchar("sandbox_reuse_result", { length: 50 }),
    result: jsonb("result"),
    error: text("error"),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    runnerGroup: varchar("runner_group", { length: 255 }),
  },
  (table) => {
    return [
      // Composite index for user listing with time-based sorting
      index("idx_agent_runs_user_created").on(
        table.userId,
        table.createdAt.desc(),
      ),
      index("idx_agent_runs_org").on(table.orgId),
      // Composite index for status-based heartbeat queries
      index("idx_agent_runs_status_heartbeat").on(
        table.status,
        table.lastHeartbeatAt,
      ),
      // Partial index for cron cleanup (only running status)
      index("idx_agent_runs_running_heartbeat")
        .on(table.lastHeartbeatAt)
        .where(sql`status = 'running'`),
      // Composite index for org+status queries (concurrency checks, queue listing)
      index("idx_agent_runs_org_status_created").on(
        table.orgId,
        table.status,
        table.createdAt.desc(),
      ),
      index("idx_agent_runs_session").on(table.sessionId),
    ];
  },
);

/**
 * Agent Sessions table
 * Lightweight compose to conversation association for continue operations
 * Sessions always use HEAD compose version at runtime, with no snapshotting.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentComposeId: uuid("agent_compose_id")
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    conversationId: uuid("conversation_id").references(
      (): AnyPgColumn => {
        return conversations.id;
      },
      {
        onDelete: "set null",
      },
    ),
    artifacts: jsonb("artifacts")
      .$type<ContextArtifact[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agent_sessions_user_compose").on(
        table.userId,
        table.agentComposeId,
      ),
      index("idx_agent_sessions_org").on(table.orgId),
    ];
  },
);

/**
 * Conversations table
 * Stores CLI agent conversation history for checkpoint resumption
 *
 * Session history storage strategy:
 * - New records use cliAgentSessionHistoryHash (R2 blob reference)
 * - Legacy records use cliAgentSessionHistory (TEXT field)
 * - Read logic: prioritize hash, fallback to TEXT
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(
      (): AnyPgColumn => {
        return agentRuns.id;
      },
      { onDelete: "cascade" },
    )
    .notNull()
    .unique(),
  cliAgentType: varchar("cli_agent_type", { length: 64 }).notNull(),
  cliAgentSessionId: varchar("cli_agent_session_id", { length: 255 }).notNull(),
  /** @deprecated Legacy TEXT storage - new records use hash instead */
  cliAgentSessionHistory: text("cli_agent_session_history"),
  /** SHA-256 hash reference to R2 blob storage */
  cliAgentSessionHistoryHash: varchar("cli_agent_session_history_hash", {
    length: 64,
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
