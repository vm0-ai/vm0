import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentComposeVersions } from "./agent-compose";
import { runners } from "./runner";

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
  // Runner-related fields for self-hosted execution
  runnerGroup: varchar("runner_group", { length: 255 }),
  runnerId: uuid("runner_id").references(() => runners.id),
  claimedAt: timestamp("claimed_at"),
});
