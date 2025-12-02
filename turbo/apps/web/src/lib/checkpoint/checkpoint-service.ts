import { eq } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { conversations } from "../../db/schema/conversation";
import { checkpoints } from "../../db/schema/checkpoint";
import { NotFoundError } from "../errors";
import { agentSessionService } from "../agent-session";
import { logger } from "../logger";
import type {
  CheckpointRequest,
  CheckpointResponse,
  AgentComposeSnapshot,
  ArtifactSnapshot,
  VolumeVersionsSnapshot,
} from "./types";

const log = logger("service:checkpoint");

/**
 * Checkpoint Service
 * Manages creation and storage of agent run checkpoints
 */
export class CheckpointService {
  /**
   * Create a checkpoint for an agent run
   *
   * @param request Checkpoint request data from webhook
   * @returns Checkpoint ID and artifact status
   * @throws NotFoundError if run doesn't exist
   */
  async createCheckpoint(
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
      throw new NotFoundError("Agent run");
    }

    // Fetch agent compose version to get composeId for session
    const [version] = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, run.agentComposeVersionId))
      .limit(1);

    if (!version) {
      throw new NotFoundError("Agent compose version");
    }

    log.debug(
      `Creating conversation record for CLI agent: ${request.cliAgentType}`,
    );

    // Create conversation record first
    const [conversation] = await globalThis.services.db
      .insert(conversations)
      .values({
        runId: request.runId,
        cliAgentType: request.cliAgentType,
        cliAgentSessionId: request.cliAgentSessionId,
        cliAgentSessionHistory: request.cliAgentSessionHistory,
      })
      .returning();

    if (!conversation) {
      throw new Error("Failed to create conversation record");
    }

    log.debug(
      `Conversation created: ${conversation.id}, storing checkpoint...`,
    );

    // Build agent compose snapshot using version ID for reproducibility
    const agentComposeSnapshot: AgentComposeSnapshot = {
      agentComposeVersionId: run.agentComposeVersionId,
      templateVars: (run.templateVars as Record<string, string>) || undefined,
    };

    // Store checkpoint in database
    const [checkpoint] = await globalThis.services.db
      .insert(checkpoints)
      .values({
        runId: request.runId,
        conversationId: conversation.id,
        agentComposeSnapshot: agentComposeSnapshot as unknown as Record<
          string,
          unknown
        >,
        artifactSnapshot: request.artifactSnapshot as unknown as Record<
          string,
          unknown
        >,
        volumeVersionsSnapshot: request.volumeVersionsSnapshot
          ? (request.volumeVersionsSnapshot as unknown as Record<
              string,
              unknown
            >)
          : null,
      })
      .returning();

    if (!checkpoint) {
      throw new Error("Failed to create checkpoint record");
    }

    log.debug(`Checkpoint created successfully: ${checkpoint.id}`);

    // Find or create agent session using compose ID (not version ID)
    // Sessions track the mutable compose, not a specific version
    const artifactSnapshot = request.artifactSnapshot as ArtifactSnapshot;
    const templateVars =
      (run.templateVars as Record<string, string>) || undefined;
    const { session: agentSession } = await agentSessionService.findOrCreate(
      run.userId,
      version.composeId,
      artifactSnapshot.artifactName,
      conversation.id,
      templateVars,
    );

    log.debug(`Agent session updated/created: ${agentSession.id}`);

    // Extract volume versions from snapshot
    const volumeSnapshot = request.volumeVersionsSnapshot as
      | VolumeVersionsSnapshot
      | undefined;
    const volumes = volumeSnapshot?.versions;

    return {
      checkpointId: checkpoint.id,
      agentSessionId: agentSession.id,
      conversationId: conversation.id,
      artifact: artifactSnapshot,
      volumes,
    };
  }
}

// Export singleton instance
export const checkpointService = new CheckpointService();
