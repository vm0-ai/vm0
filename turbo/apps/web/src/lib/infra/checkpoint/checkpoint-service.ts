import { eq } from "drizzle-orm";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../db/schema/agent-compose";
import { conversations } from "../../../db/schema/conversation";
import { checkpoints } from "../../../db/schema/checkpoint";
import { notFound } from "../../shared/errors";
import { createAgentSession, updateAgentSession } from "../agent-session";
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

  // Upsert checkpoint record (handles retries atomically)
  const snapshotFields = {
    conversationId: conversation.id,
    agentComposeSnapshot: agentComposeSnapshot as unknown as Record<
      string,
      unknown
    >,
    artifactSnapshot: request.artifactSnapshot
      ? (request.artifactSnapshot as unknown as Record<string, unknown>)
      : null,
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

  // Resolve agent session
  // For session continuations, update the existing session's conversation reference.
  // For new runs, always create a new session (with artifact name if present).
  const artifactSnapshot = request.artifactSnapshot as
    | ArtifactSnapshot
    | undefined;
  const memorySnapshot = request.memorySnapshot as MemorySnapshot | undefined;
  const volumeSnapshot = request.volumeVersionsSnapshot as
    | VolumeVersionsSnapshot
    | undefined;

  let agentSession;
  if (run.sessionId) {
    // New path: session was pre-created at run insertion (common case post-deploy).
    // Bind the conversation and record any per-run snapshot fields that were
    // not known at insertion time (e.g., memoryName from the runtime snapshot).
    agentSession = await updateAgentSession(run.sessionId, conversation.id, {
      artifactName: artifactSnapshot?.artifactName,
      memoryName: memorySnapshot?.memoryName,
    });
  } else if (run.continuedFromSessionId) {
    // Legacy continuation in flight at deploy time: pre-existing session gets
    // its conversation reference updated.
    agentSession = await updateAgentSession(
      run.continuedFromSessionId,
      conversation.id,
    );
  } else {
    // Legacy first-run created by old web before this deploy. Create the
    // session now AND backfill agent_runs.session_id so downstream consumers
    // (and the Release 2 migration) see a populated value.
    agentSession = await createAgentSession({
      userId: run.userId,
      orgId: run.orgId,
      agentComposeId: version.composeId,
      artifactName: artifactSnapshot?.artifactName,
      memoryName: memorySnapshot?.memoryName,
      conversationId: conversation.id,
    });
    await globalThis.services.db
      .update(agentRuns)
      .set({ sessionId: agentSession.id })
      .where(eq(agentRuns.id, run.id));
  }

  log.debug(`Agent session updated/created: ${agentSession.id}`);

  // Use volume versions from snapshot for return value
  const volumes = volumeSnapshot?.versions;

  return {
    checkpointId: checkpoint.id,
    agentSessionId: agentSession.id,
    conversationId: conversation.id,
    artifact: artifactSnapshot,
    volumes,
  };
}
