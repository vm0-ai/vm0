import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentComposeVersions } from "./agent-compose";

/**
 * Agent Runs table
 * Created when developer executes agent via SDK
 * References immutable compose version for reproducibility
 */
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(), // Clerk user ID - owner of this run
  agentComposeVersionId: varchar("agent_compose_version_id", { length: 64 })
    .references(() => agentComposeVersions.id)
    .notNull(),
  resumedFromCheckpointId: uuid("resumed_from_checkpoint_id"),
  // References agent_schedules.id if this run was triggered by a schedule
  // No FK constraint to avoid circular dependency with agent_schedules
  scheduleId: uuid("schedule_id"),
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
});
