import { eq, and } from "drizzle-orm";
import { checkpoints } from "../../../../db/schema/checkpoint";
import { conversations } from "../../../../db/schema/conversation";
import { agentRuns } from "../../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../../db/schema/agent-compose";
import { notFound, unauthorized, badRequest } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
import type {
  ArtifactSnapshot,
  AgentComposeSnapshot,
  MemorySnapshot,
  VolumeVersionsSnapshot,
} from "../../checkpoint/types";
import type { AgentComposeYaml } from "../../agent-compose/types";
import type { ConversationResolution } from "./types";
import { extractWorkingDir } from "../utils";
import { resolveSessionHistory } from "./resolve-session-history";

const log = logger("run:resolve-checkpoint");

/**
 * Resolve checkpoint to ConversationResolution
 *
 * @param checkpointId Checkpoint ID to resolve
 * @param userId User ID for authorization
 * @returns ConversationResolution with all data needed to build execution context
 * @throws NotFoundError if checkpoint or related data not found
 * @throws UnauthorizedError if checkpoint doesn't belong to user
 * @throws BadRequestError if checkpoint data is invalid
 */
export async function resolveCheckpoint(
  checkpointId: string,
  userId: string,
): Promise<ConversationResolution> {
  log.debug(`Resolving checkpoint ${checkpointId} for user ${userId}`);

  const [checkpoint] = await globalThis.services.db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.id, checkpointId))
    .limit(1);

  if (!checkpoint) {
    throw notFound("Checkpoint not found");
  }

  // Extract snapshots (artifactSnapshot may be null for runs without artifact)
  const agentComposeSnapshot =
    checkpoint.agentComposeSnapshot as unknown as AgentComposeSnapshot;
  const checkpointArtifact =
    checkpoint.artifactSnapshot as unknown as ArtifactSnapshot | null;
  const checkpointMemory =
    checkpoint.memorySnapshot as unknown as MemorySnapshot | null;
  const checkpointVolumeVersions =
    checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

  // Extract additional volumes from enriched snapshot (pinned versions from checkpoint)
  const checkpointAdditionalVolumes =
    checkpointVolumeVersions?.additionalVolumes?.map((vol) => {
      return {
        name: vol.name,
        version: vol.versionId,
        mountPath: vol.mountPath,
      };
    });

  // Get version ID from snapshot
  const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
  if (!agentComposeVersionId) {
    throw badRequest("Invalid checkpoint: missing agentComposeVersionId");
  }

  // Verify checkpoint belongs to user (must complete before doing further work)
  const [originalRun] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, checkpoint.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1);

  if (!originalRun) {
    throw unauthorized("Checkpoint does not belong to authenticated user");
  }

  // Run independent queries in parallel:
  // - Conversation → session history chain (needs checkpoint.conversationId)
  // - Compose version lookup (needs snapshot.agentComposeVersionId)
  const [conversationResult, versionResult] = await Promise.all([
    // Conversation → session history (serial chain)
    (async () => {
      const [conversation] = await globalThis.services.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, checkpoint.conversationId))
        .limit(1);

      if (!conversation) {
        throw notFound("Conversation not found");
      }

      const sessionHistory = await resolveSessionHistory(
        conversation.cliAgentSessionHistoryHash,
        conversation.cliAgentSessionHistory,
      );

      return { conversation, sessionHistory };
    })(),
    // Compose version lookup
    globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, agentComposeVersionId))
      .limit(1),
  ]);

  const { conversation, sessionHistory } = conversationResult;

  const [version] = versionResult;
  if (!version) {
    throw notFound(`Agent compose version ${agentComposeVersionId} not found`);
  }
  const agentCompose = version.content as AgentComposeYaml;

  return {
    conversationId: checkpoint.conversationId,
    agentComposeVersionId,
    agentCompose,
    workingDir: extractWorkingDir(agentCompose),
    conversationData: {
      cliAgentSessionId: conversation.cliAgentSessionId,
      cliAgentSessionHistory: sessionHistory,
    },
    artifactName: checkpointArtifact?.artifactName,
    artifactVersion: checkpointArtifact?.artifactVersion,
    memoryName: checkpointMemory?.memoryName,
    vars: agentComposeSnapshot.vars || {},
    volumeVersions: checkpointVolumeVersions?.versions,
    additionalVolumes: checkpointAdditionalVolumes,
    buildResumeArtifact: !!checkpointArtifact, // Only build resumeArtifact if checkpoint has artifact
  };
}
