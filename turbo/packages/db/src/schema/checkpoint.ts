import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { conversations } from "./conversation";
import type {
  CheckpointAgentComposeSnapshot,
  CheckpointArtifactSnapshots,
  CheckpointStorageMounts,
  CheckpointVolumeVersionsSnapshot,
} from "@vm0/db/jsonb-contracts/checkpoint";

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
  agentComposeSnapshot: jsonb("agent_compose_snapshot")
    .$type<CheckpointAgentComposeSnapshot>()
    .notNull(),
  artifactSnapshots:
    jsonb("artifact_snapshots").$type<CheckpointArtifactSnapshots>(),
  volumeVersionsSnapshot: jsonb(
    "volume_versions_snapshot",
  ).$type<CheckpointVolumeVersionsSnapshot>(),
  // Canonical exact mount snapshot. The legacy artifact/volume snapshots stay
  // populated during the rollback window.
  storageMounts: jsonb("storage_mounts").$type<CheckpointStorageMounts>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
