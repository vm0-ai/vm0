import { eq } from "drizzle-orm";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../db/schema/agent-compose";
import { conversations } from "../../../db/schema/conversation";
import { checkpoints } from "../../../db/schema/checkpoint";
import { notFound } from "../../shared/errors";
import { updateAgentSession } from "../agent-session";
import { registerSessionHistoryBlob } from "../session-history";
import { logger } from "../../shared/logger";
import type {
  CheckpointRequest,
  CheckpointResponse,
  AgentComposeSnapshot,
  ArtifactSnapshot,
  MemorySnapshot,
  VolumeVersionsSnapshot,
} from "./types";

const log = logger("checkpoint");

/**
 * Resolve the artifact snapshot pair (legacy single + new multi-entry map)
 * from a checkpoint request. The multi-entry map is authoritative; a legacy
 * single-entry record is derived from its first entry so old readers keep
 * working for the duration of the rollout.
 */
function resolveArtifactSnapshots(request: CheckpointRequest): {
  legacy: ArtifactSnapshot | null;
  map: Record<string, string> | null;
  hasMap: boolean;
} {
  const map = request.artifactSnapshots ?? null;
  const hasMap = map !== null && Object.keys(map).length > 0;
  if (hasMap) {
    const [artifactName, artifactVersion] = Object.entries(map)[0]!;
    return { legacy: { artifactName, artifactVersion }, map, hasMap };
  }
  return { legacy: request.artifactSnapshot ?? null, map, hasMap };
}

/**
 * Create a checkpoint for an agent run
 *
 * @param request Checkpoint request data from webhook
 * @returns Checkpoint ID and artifact status
 * @throws NotFoundError if run doesn't exist
 */
export async function createCheckpoint(
  request: CheckpointRequest,
): Promise<CheckpointResponse> {
  log.debug(`Creating checkpoint for run ${request.runId}`);

  // Fetch agent run from database
  const [run] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, request.runId))
    .limit(1);

  if (!run) {
    throw notFound("Agent run not found");
  }

  // agentComposeVersionId may be null if agent was deleted (historical runs)
  // but during active run execution it should always be present
  if (!run.agentComposeVersionId) {
    throw notFound(
      "Agent compose version not found (agent may have been deleted)",
    );
  }

  // Fetch agent compose version to get composeId for session
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, run.agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw notFound("Agent compose version not found");
  }

  log.debug(
    `Creating conversation record for CLI agent: ${request.cliAgentType}`,
  );

  // Register session history blob (content already uploaded via presigned URL)
  const historyHash = await registerSessionHistoryBlob(
    request.cliAgentSessionHistoryHash,
  );
  log.debug(`Session history blob registered, hash=${historyHash}`);

  // Upsert conversation record (handles retries atomically)
  const [conversation] = await globalThis.services.db
    .insert(conversations)
    .values({
      runId: request.runId,
      cliAgentType: request.cliAgentType,
      cliAgentSessionId: request.cliAgentSessionId,
      cliAgentSessionHistoryHash: historyHash,
    })
    .onConflictDoUpdate({
      target: conversations.runId,
      set: {
        cliAgentType: request.cliAgentType,
        cliAgentSessionId: request.cliAgentSessionId,
        cliAgentSessionHistoryHash: historyHash,
      },
    })
    .returning();

  if (!conversation) {
    throw new Error("Failed to upsert conversation record");
  }

  log.debug(`Conversation created: ${conversation.id}, storing checkpoint...`);

  // Build agent compose snapshot using version ID for reproducibility
  // Environment is re-expanded from vars/secrets on resume
  // Note: secrets values are NEVER stored - only names for validation
  const agentComposeSnapshot: AgentComposeSnapshot = {
    agentComposeVersionId: run.agentComposeVersionId,
    vars: (run.vars as Record<string, string>) || undefined,
    secretNames: (run.secretNames as string[]) || undefined,
  };

  // Enrich volume versions snapshot with additional volumes from run record
  const runAdditionalVolumes = run.additionalVolumes as Array<{
    name: string;
    version?: string;
    mountPath: string;
  }> | null;

  const enrichedVolumeSnapshot = request.volumeVersionsSnapshot
    ? {
        versions: request.volumeVersionsSnapshot.versions,
        ...(runAdditionalVolumes && runAdditionalVolumes.length > 0
          ? {
              additionalVolumes: runAdditionalVolumes.map((vol) => {
                const versionId =
                  request.volumeVersionsSnapshot!.versions[vol.name] ??
                  vol.version;
                if (!versionId) {
                  log.warn(
                    `Additional volume "${vol.name}" has no resolved version from runner and no version specified at run time, defaulting to "latest"`,
                  );
                }
                return {
                  name: vol.name,
                  versionId: versionId ?? "latest",
                  mountPath: vol.mountPath,
                };
              }),
            }
          : {}),
      }
    : null;

  // Consolidate artifact snapshots. The guest-agent emits artifactSnapshots
  // (name -> version map) as the authoritative multi-mount payload, and still
  // emits artifactSnapshot for backward compat when exactly one artifact is
  // snapshotted. See resolveArtifactSnapshots above.
  const {
    legacy: legacyArtifactSnapshot,
    map: artifactSnapshotsMap,
    hasMap: hasArtifactSnapshots,
  } = resolveArtifactSnapshots(request);

  // Upsert checkpoint record (handles retries atomically). Double-write both
  // the legacy singleton column and the new multi-entry JSONB column for the
  // duration of the rollout (see migration 0295).
  const snapshotFields = {
    conversationId: conversation.id,
    agentComposeSnapshot: agentComposeSnapshot as unknown as Record<
      string,
      unknown
    >,
    artifactSnapshot: legacyArtifactSnapshot
      ? (legacyArtifactSnapshot as unknown as Record<string, unknown>)
      : null,
    artifactSnapshots: artifactSnapshotsMap as Record<string, string> | null,
    memorySnapshot: request.memorySnapshot
      ? (request.memorySnapshot as unknown as Record<string, unknown>)
      : null,
    volumeVersionsSnapshot: enrichedVolumeSnapshot as unknown as Record<
      string,
      unknown
    > | null,
  };

  const [checkpoint] = await globalThis.services.db
    .insert(checkpoints)
    .values({
      runId: request.runId,
      ...snapshotFields,
    })
    .onConflictDoUpdate({
      target: checkpoints.runId,
      set: snapshotFields,
    })
    .returning();

  if (!checkpoint) {
    throw new Error("Failed to upsert checkpoint record");
  }

  log.debug(`Checkpoint created successfully: ${checkpoint.id}`);

  // Bind the pre-created agent session (always populated since #10323 made
  // agent_runs.session_id NOT NULL) to this conversation and record per-run
  // snapshot fields that were not known when the session was created eagerly
  // at run insertion.
  const memorySnapshot = request.memorySnapshot as MemorySnapshot | undefined;
  const volumeSnapshot = request.volumeVersionsSnapshot as
    | VolumeVersionsSnapshot
    | undefined;

  if (!run.sessionId) {
    throw notFound("Agent run has no session_id");
  }
  const agentSession = await updateAgentSession(
    run.sessionId,
    conversation.id,
    {
      artifactName: legacyArtifactSnapshot?.artifactName,
      memoryName: memorySnapshot?.memoryName,
    },
  );

  log.debug(`Agent session updated/created: ${agentSession.id}`);

  // Use volume versions from snapshot for return value
  const volumes = volumeSnapshot?.versions;

  return {
    checkpointId: checkpoint.id,
    agentSessionId: agentSession.id,
    conversationId: conversation.id,
    artifact: legacyArtifactSnapshot ?? undefined,
    artifacts: hasArtifactSnapshots
      ? (artifactSnapshotsMap ?? undefined)
      : undefined,
    volumes,
  };
}
