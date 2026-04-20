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
import { agentComposeVersions } from "./agent-compose";
import { agentSessions } from "./agent-session";

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
        { onDelete: "restrict" },
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
