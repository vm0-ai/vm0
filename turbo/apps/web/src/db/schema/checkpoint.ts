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
    .references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "cascade" },
    )
    .notNull()
    .unique(),
  conversationId: uuid("conversation_id")
    .references(
      () => {
        return conversations.id;
      },
      { onDelete: "cascade" },
    )
    .notNull(),
  agentComposeSnapshot: jsonb("agent_compose_snapshot").notNull(),
  // Legacy single-entry snapshot kept alongside artifactSnapshots for the
  // duration of the multi-mount rollout. New writers double-write both, and
  // readers that only need the first entry can keep reading this column.
  artifactSnapshot: jsonb("artifact_snapshot"),
  // Multi-entry artifact snapshot: { [artifactName]: versionId }. Emitted by
  // the guest-agent per checkpoint. Null for legacy rows created before the
  // migration.
  artifactSnapshots: jsonb("artifact_snapshots"),
  memorySnapshot: jsonb("memory_snapshot"),
  volumeVersionsSnapshot: jsonb("volume_versions_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
