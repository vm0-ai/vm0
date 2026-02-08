import { eq } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { conversations } from "../../db/schema/conversation";
import { checkpoints } from "../../db/schema/checkpoint";
import { notFound } from "../errors";
import { findOrCreateAgentSession } from "../agent-session";
import { storeSessionHistory } from "../session-history";
import { logger } from "../logger";
import type {
  CheckpointRequest,
  CheckpointResponse,
  AgentComposeSnapshot,
  ArtifactSnapshot,
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

  // Store session history in R2 blob storage
  const historyHash = await storeSessionHistory(request.cliAgentSessionHistory);
  log.debug(`Session history stored in R2, hash=${historyHash}`);

  // Check if conversation already exists for this run (e.g., from a retry)
  const [existingConversation] = await globalThis.services.db
    .select()
    .from(conversations)
    .where(eq(conversations.runId, request.runId))
    .limit(1);

  let conversation;
  if (existingConversation) {
    // Update existing conversation with new session data
    log.debug(`Updating existing conversation for run ${request.runId}`);
    const [updated] = await globalThis.services.db
      .update(conversations)
      .set({
        cliAgentType: request.cliAgentType,
        cliAgentSessionId: request.cliAgentSessionId,
        cliAgentSessionHistoryHash: historyHash,
      })
      .where(eq(conversations.runId, request.runId))
      .returning();
    conversation = updated;
  } else {
    // Create new conversation record
    const [inserted] = await globalThis.services.db
      .insert(conversations)
      .values({
        runId: request.runId,
        cliAgentType: request.cliAgentType,
        cliAgentSessionId: request.cliAgentSessionId,
        cliAgentSessionHistoryHash: historyHash,
      })
      .returning();
    conversation = inserted;
  }

  if (!conversation) {
    throw new Error("Failed to create/update conversation record");
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

  // Check if checkpoint already exists for this run (e.g., from a retry)
  const [existingCheckpoint] = await globalThis.services.db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, request.runId))
    .limit(1);

  let checkpoint;
  if (existingCheckpoint) {
    // Update existing checkpoint with new data
    log.debug(`Updating existing checkpoint for run ${request.runId}`);
    const [updated] = await globalThis.services.db
      .update(checkpoints)
      .set({
        conversationId: conversation.id,
        agentComposeSnapshot: agentComposeSnapshot as unknown as Record<
          string,
          unknown
        >,
        artifactSnapshot: request.artifactSnapshot
          ? (request.artifactSnapshot as unknown as Record<string, unknown>)
          : null,
        volumeVersionsSnapshot: request.volumeVersionsSnapshot
          ? (request.volumeVersionsSnapshot as unknown as Record<
              string,
              unknown
            >)
          : null,
      })
      .where(eq(checkpoints.runId, request.runId))
      .returning();
    checkpoint = updated;
  } else {
    // Create new checkpoint record (artifactSnapshot may be undefined for runs without artifact)
    const [inserted] = await globalThis.services.db
      .insert(checkpoints)
      .values({
        runId: request.runId,
        conversationId: conversation.id,
        agentComposeSnapshot: agentComposeSnapshot as unknown as Record<
          string,
          unknown
        >,
        artifactSnapshot: request.artifactSnapshot
          ? (request.artifactSnapshot as unknown as Record<string, unknown>)
          : null,
        volumeVersionsSnapshot: request.volumeVersionsSnapshot
          ? (request.volumeVersionsSnapshot as unknown as Record<
              string,
              unknown
            >)
          : null,
      })
      .returning();
    checkpoint = inserted;
  }

  if (!checkpoint) {
    throw new Error("Failed to create/update checkpoint record");
  }

  log.debug(`Checkpoint created successfully: ${checkpoint.id}`);

  // Find or create agent session
  // Sessions are lightweight compose ↔ conversation associations
  // artifactSnapshot may be undefined for runs without artifact
  const artifactSnapshot = request.artifactSnapshot as
    | ArtifactSnapshot
    | undefined;
  const volumeSnapshot = request.volumeVersionsSnapshot as
    | VolumeVersionsSnapshot
    | undefined;
  const { session: agentSession } = await findOrCreateAgentSession(
    run.userId,
    version.composeId,
    artifactSnapshot?.artifactName, // May be undefined for runs without artifact
    conversation.id,
  );

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
