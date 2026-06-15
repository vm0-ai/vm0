import { computed, type Computed } from "ccstate";
import {
  agentComposeSnapshotSchema,
  volumeVersionsSnapshotSchema,
  type CheckpointResponse,
} from "@vm0/api-contracts/contracts/sessions";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

interface AgentCheckpointByIdArgs {
  readonly checkpointId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface ContextArtifactSnapshot {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
}

function isContextArtifactSnapshot(
  value: unknown,
): value is ContextArtifactSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.mountPath === "string" &&
    (entry.version === undefined || typeof entry.version === "string")
  );
}

function isEmptyArtifactPayload(raw: unknown): boolean {
  if (raw === null || raw === undefined) {
    return true;
  }
  if (Array.isArray(raw)) {
    return raw.length === 0;
  }
  if (typeof raw === "object") {
    return Object.keys(raw).length === 0;
  }
  return false;
}

function artifactSnapshotsToRecord(
  raw: unknown,
): Record<string, string> | null {
  if (isEmptyArtifactPayload(raw)) {
    return null;
  }
  if (!Array.isArray(raw)) {
    throw new Error("Invalid checkpoint: artifactSnapshots must be an array");
  }

  const result: Record<string, string> = {};
  for (const [index, entry] of raw.entries()) {
    if (!isContextArtifactSnapshot(entry)) {
      throw new Error(
        `Invalid checkpoint: artifactSnapshots[${index}] is not a valid ContextArtifact`,
      );
    }
    if (entry.version === undefined) {
      throw new Error(
        `Invalid checkpoint: artifactSnapshots[${index}] has no version`,
      );
    }
    result[entry.name] = entry.version;
  }
  return result;
}

export function agentCheckpointById(
  args: AgentCheckpointByIdArgs,
): Computed<Promise<CheckpointResponse | null>> {
  return computed(async (get): Promise<CheckpointResponse | null> => {
    const [row] = await get(db$)
      .select({
        id: checkpoints.id,
        runId: checkpoints.runId,
        conversationId: checkpoints.conversationId,
        agentComposeSnapshot: checkpoints.agentComposeSnapshot,
        artifactSnapshots: checkpoints.artifactSnapshots,
        volumeVersionsSnapshot: checkpoints.volumeVersionsSnapshot,
        createdAt: checkpoints.createdAt,
      })
      .from(checkpoints)
      .innerJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
      .where(
        and(
          eq(checkpoints.id, args.checkpointId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      runId: row.runId,
      conversationId: row.conversationId,
      agentComposeSnapshot: agentComposeSnapshotSchema.parse(
        row.agentComposeSnapshot,
      ),
      artifactSnapshots: artifactSnapshotsToRecord(row.artifactSnapshots),
      volumeVersionsSnapshot: volumeVersionsSnapshotSchema
        .nullable()
        .parse(row.volumeVersionsSnapshot ?? null),
      createdAt: row.createdAt.toISOString(),
    };
  });
}
