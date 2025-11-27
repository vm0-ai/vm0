import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { conversations } from "./conversation";

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
  conversationId: uuid("conversation_id")
    .references(() => conversations.id, { onDelete: "cascade" })
    .notNull(),
  agentConfigSnapshot: jsonb("agent_config_snapshot").notNull(),
  artifactSnapshot: jsonb("artifact_snapshot").notNull(),
  volumeVersionsSnapshot: jsonb("volume_versions_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
