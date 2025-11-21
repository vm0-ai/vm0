import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Agent Checkpoints table
 * Stores checkpoint data for resumable agent runs
 */
export const agentCheckpoints = pgTable("agent_checkpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => agentRuns.id)
    .notNull(),
  parentCheckpointId: uuid("parent_checkpoint_id"), // If resumed from another checkpoint

  // Claude Code session
  sessionId: varchar("session_id", { length: 255 }).notNull(),
  sessionContent: text("session_content").notNull(), // JSONL content stored directly in DB

  // Volume snapshots (array of volume states)
  volumeSnapshots: jsonb("volume_snapshots").notNull(),

  // Context metadata
  workingDirectory: text("working_directory").notNull(),
  encodedPath: varchar("encoded_path", { length: 500 }).notNull(),

  // Run metadata
  model: varchar("model", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * TypeScript interface for volume snapshot
 */
export interface VolumeSnapshot {
  volumeName: string;
  driver: "s3fs" | "git";
  uri: string;

  // For git driver
  commitSha?: string;
  branch?: string;
  repo?: string;

  // For s3fs driver
  s3Path?: string;
}
