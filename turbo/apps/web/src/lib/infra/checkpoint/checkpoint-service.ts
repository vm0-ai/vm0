import { and, eq } from "drizzle-orm";
import { agentRuns } from "../../../db/schema/agent-run";
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
  VolumeVersionsSnapshot,
} from "./types";
import {
  decodeToContextArtifacts,
  isEmptyArtifactPayload,
} from "./decode-artifact-snapshots";

const log = logger("checkpoint");

/**
 * Create a checkpoint for an agent run.
 *
 * `userId` is checked against `agent_runs.user_id` as a defence-in-depth
 * tripwire: sandbox tokens are HMAC-signed and bind `userId`/`runId`
 * together at mint time, so a mismatch here shouldn't be reachable in
 * production. The check is retained so a leaked signing key or a
 * handler refactor regression would 404 rather than write to a foreign
 * user's run.
 *
 * @param request Checkpoint request data from webhook
 * @param userId  Authenticated userId from the sandbox token
 * @returns Checkpoint ID and artifact status
 * @throws NotFoundError if run doesn't exist or doesn't belong to userId
 */
export async function createCheckpoint(
  request: CheckpointRequest,
  userId: string,
): Promise<CheckpointResponse> {
  log.debug(`Creating checkpoint for run ${request.runId}`);

  // Fetch agent run from database
  const [run] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, request.runId), eq(agentRuns.userId, userId)))
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

  // Normalise the artifactSnapshots payload before persisting. The webhook
  // contract now only accepts the canonical Array<{name, version, mountPath}>
  // shape; empty payloads (null, []) collapse to NULL so "no artifacts" has
  // a single on-disk representation.
  const rawPayload = request.artifactSnapshots ?? null;
  const artifactSnapshotsForDb = isEmptyArtifactPayload(rawPayload)
    ? null
    : decodeToContextArtifacts(rawPayload);

  const snapshotFields = {
    conversationId: conversation.id,
    agentComposeSnapshot: agentComposeSnapshot as unknown as Record<
      string,
      unknown
    >,
    artifactSnapshots: artifactSnapshotsForDb,
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
  const volumeSnapshot = request.volumeVersionsSnapshot as
    | VolumeVersionsSnapshot
    | undefined;

  if (!run.sessionId) {
    throw notFound("Agent run has no session_id");
  }
  const agentSession = await updateAgentSession(run.sessionId, conversation.id);

  log.debug(`Agent session updated/created: ${agentSession.id}`);

  // Use volume versions from snapshot for return value
  const volumes = volumeSnapshot?.versions;

  // Echo back the persisted canonical shape. The webhook contract requires
  // `version` on every entry, so the undefined-branch assertion guards
  // against a ContextArtifact leaking in from a non-webhook caller.
  const responseArtifacts = artifactSnapshotsForDb?.map((entry) => {
    if (entry.version === undefined) {
      throw new Error(
        `Invalid checkpoint: artifact "${entry.name}" missing version after normalisation`,
      );
    }
    return {
      name: entry.name,
      version: entry.version,
      mountPath: entry.mountPath,
    };
  });

  return {
    checkpointId: checkpoint.id,
    agentSessionId: agentSession.id,
    conversationId: conversation.id,
    artifacts: responseArtifacts,
    volumes,
  };
}
