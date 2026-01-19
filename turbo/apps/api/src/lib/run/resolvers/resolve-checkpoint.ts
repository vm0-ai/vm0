import { eq, and } from "drizzle-orm";
import { checkpoints } from "../../../db/schema/checkpoint";
import { conversations } from "../../../db/schema/conversation";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../db/schema/agent-compose";
import {
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
} from "../../errors";
import { logger } from "../../logger";
import type {
  ArtifactSnapshot,
  AgentComposeSnapshot,
  VolumeVersionsSnapshot,
} from "../../checkpoint/types";
import type { AgentComposeYaml } from "../../../types/agent-compose";
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
    throw new NotFoundError("Checkpoint not found");
  }

  // Verify checkpoint belongs to user
  const [originalRun] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, checkpoint.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1);

  if (!originalRun) {
    throw new UnauthorizedError(
      "Checkpoint does not belong to authenticated user",
    );
  }

  // Load conversation
  const [conversation] = await globalThis.services.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, checkpoint.conversationId))
    .limit(1);

  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }

  // Extract snapshots (artifactSnapshot may be null for runs without artifact)
  const agentComposeSnapshot =
    checkpoint.agentComposeSnapshot as unknown as AgentComposeSnapshot;
  const checkpointArtifact =
    checkpoint.artifactSnapshot as unknown as ArtifactSnapshot | null;
  const checkpointVolumeVersions =
    checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

  // Get version ID from snapshot
  const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
  if (!agentComposeVersionId) {
    throw new BadRequestError(
      "Invalid checkpoint: missing agentComposeVersionId",
    );
  }

  // Lookup content from version table
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw new NotFoundError(
      `Agent compose version ${agentComposeVersionId} not found`,
    );
  }
  const agentCompose = version.content as AgentComposeYaml;

  // Get secret names from snapshot (values are NEVER stored)
  const secretNames = agentComposeSnapshot.secretNames as string[] | undefined;

  // Resolve session history from R2 hash or legacy TEXT field
  const sessionHistory = await resolveSessionHistory(
    conversation.cliAgentSessionHistoryHash,
    conversation.cliAgentSessionHistory,
  );

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
    vars: agentComposeSnapshot.vars || {},
    secretNames,
    volumeVersions: checkpointVolumeVersions?.versions,
    buildResumeArtifact: !!checkpointArtifact, // Only build resumeArtifact if checkpoint has artifact
  };
}
