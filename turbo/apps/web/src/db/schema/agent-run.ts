import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agentComposeVersions } from "./agent-compose";
import { agentSchedules } from "./agent-schedule";

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
    }).references(() => agentComposeVersions.id, { onDelete: "set null" }),
    resumedFromCheckpointId: uuid("resumed_from_checkpoint_id"),
    // References agent_schedules.id if this run was triggered by a schedule
    scheduleId: uuid("schedule_id").references(
      (): AnyPgColumn => agentSchedules.id,
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 20 }).notNull(),
    prompt: text("prompt").notNull(),
    vars: jsonb("vars"),
    // Secret names for validation (values never stored - must be provided at runtime)
    secretNames: jsonb("secret_names").$type<string[]>(),
    sandboxId: varchar("sandbox_id", { length: 255 }),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
  },
  (table) => [
    // Composite index for user listing with time-based sorting
    index("idx_agent_runs_user_created").on(table.userId, table.createdAt),
    // Partial index for cron cleanup (only running status)
    index("idx_agent_runs_running_heartbeat")
      .on(table.lastHeartbeatAt)
      .where("status = 'running'" as never),
    // Partial index for schedule history (only scheduled runs)
    index("idx_agent_runs_schedule_created")
      .on(table.scheduleId, table.createdAt)
      .where("schedule_id IS NOT NULL" as never),
  ],
);
