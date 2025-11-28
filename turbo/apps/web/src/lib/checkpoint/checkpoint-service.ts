import { eq } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { agentConfigs } from "../../db/schema/agent-config";
import { conversations } from "../../db/schema/conversation";
import { checkpoints } from "../../db/schema/checkpoint";
import { NotFoundError } from "../errors";
import { agentSessionService } from "../agent-session";
import { logger } from "../logger";
import type {
  CheckpointRequest,
  CheckpointResponse,
  AgentConfigSnapshot,
  ArtifactSnapshot,
} from "./types";
import type { AgentConfigYaml } from "../../types/agent-config";

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

    // Fetch agent config to create snapshot
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, run.agentConfigId))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
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

    // Build agent config snapshot
    const agentConfigSnapshot: AgentConfigSnapshot = {
      config: config.config as AgentConfigYaml,
      templateVars: (run.templateVars as Record<string, string>) || undefined,
    };

    // Store checkpoint in database
    const [checkpoint] = await globalThis.services.db
      .insert(checkpoints)
      .values({
        runId: request.runId,
        conversationId: conversation.id,
        agentConfigSnapshot: agentConfigSnapshot as unknown as Record<
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

    // Find or create agent session
    const artifactSnapshot = request.artifactSnapshot as ArtifactSnapshot;
    const templateVars =
      (run.templateVars as Record<string, string>) || undefined;
    const { session: agentSession } = await agentSessionService.findOrCreate(
      run.userId,
      run.agentConfigId,
      artifactSnapshot.artifactName,
      conversation.id,
      templateVars,
    );

    log.debug(`Agent session updated/created: ${agentSession.id}`);

    return {
      checkpointId: checkpoint.id,
      agentSessionId: agentSession.id,
      hasArtifact: true, // artifact is now always required
    };
  }
}

// Export singleton instance
export const checkpointService = new CheckpointService();
