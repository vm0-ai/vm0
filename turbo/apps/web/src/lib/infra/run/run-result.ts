import { checkpoints } from "@vm0/db/schema/checkpoint";
import { decodeToRecord } from "../checkpoint/decode-artifact-snapshots";
import type { RunResult } from "./types";

/**
 * Build the public run result shape from a persisted checkpoint row.
 *
 * Checkpoints store artifact snapshots in the canonical array shape while older
 * callback/event consumers still expect the compact Record<name, version> form.
 */
export function buildRunResultFromCheckpoint(
  checkpoint: typeof checkpoints.$inferSelect,
  sessionId: string | undefined,
): RunResult {
  const artifactRecord = decodeToRecord(checkpoint.artifactSnapshots);
  const volumeVersions = checkpoint.volumeVersionsSnapshot as
    | { versions?: Record<string, string> }
    | null
    | undefined;

  const result: RunResult = {
    checkpointId: checkpoint.id,
    agentSessionId: sessionId ?? checkpoint.conversationId,
    conversationId: checkpoint.conversationId,
    volumes: volumeVersions?.versions,
  };

  if (artifactRecord) {
    result.artifact = artifactRecord;
  }

  return result;
}
