import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { agentConfigs } from "./agent-config";

/**
 * Checkpoints table
 * Stores agent run state snapshots for debugging and future resumption
 */
export const checkpoints = pgTable("checkpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfigs.id)
    .notNull(),
  sessionId: varchar("session_id", { length: 255 }).notNull(),
  dynamicVars: jsonb("dynamic_vars"),
  sessionHistory: text("session_history").notNull(), // JSONL format
  artifactSnapshot: jsonb("artifact_snapshot"), // ArtifactSnapshot object or null
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
