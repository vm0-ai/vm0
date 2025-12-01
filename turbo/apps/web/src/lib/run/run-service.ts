import { eq, and } from "drizzle-orm";
import { checkpoints } from "../../db/schema/checkpoint";
import { conversations } from "../../db/schema/conversation";
import { agentRuns } from "../../db/schema/agent-run";
import { agentConfigs } from "../../db/schema/agent-config";
import { NotFoundError, UnauthorizedError } from "../errors";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession } from "./types";
import type {
  ArtifactSnapshot,
  AgentConfigSnapshot,
  VolumeVersionsSnapshot,
} from "../checkpoint/types";
import { agentSessionService } from "../agent-session";
import { e2bService } from "../e2b";
import type { RunResult } from "../e2b/types";

const log = logger("service:run");

/**
 * Intermediate resolution result from checkpoint/session/conversation expansion
 * Contains all data needed to build resumeSession uniformly
 */
interface ConversationResolution {
  conversationId: string;
  agentConfigId: string;
  agentConfig: unknown;
  workingDir: string;
  conversationData: {
    cliAgentSessionId: string;
    cliAgentSessionHistory: string;
  };
  artifactName?: string;
  artifactVersion?: string;
  templateVars?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  buildResumeArtifact: boolean;
}

/**
 * Calculate session history path based on working directory
 * Matches logic from run-agent-script.ts lines 39-42
 */
export function calculateSessionHistoryPath(
  workingDir: string,
  sessionId: string,
): string {
  // Remove leading slash and replace all slashes with hyphens
  const projectName = workingDir.replace(/^\//, "").replace(/\//g, "-");
  return `/home/user/.config/claude/projects/-${projectName}/${sessionId}.jsonl`;
}

/**
 * Run Service
 * Handles business logic for creating and resuming agent runs
 */
export class RunService {
  /**
   * Extract working directory from agent config
   */
  private extractWorkingDir(config: unknown): string {
    const configWithAgents = config as
      | { agents?: Array<{ working_dir?: string }> }
      | undefined;
    return configWithAgents?.agents?.[0]?.working_dir || "/workspace";
  }

  /**
   * Resolve checkpoint to ConversationResolution
   */
  private async resolveCheckpoint(
    checkpointId: string,
    userId: string,
  ): Promise<ConversationResolution> {
    const [checkpoint] = await globalThis.services.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, checkpointId))
      .limit(1);

    if (!checkpoint) {
      throw new NotFoundError("Checkpoint");
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
      throw new NotFoundError("Conversation");
    }

    // Extract snapshots
    const agentConfigSnapshot =
      checkpoint.agentConfigSnapshot as unknown as AgentConfigSnapshot;
    const checkpointArtifact =
      checkpoint.artifactSnapshot as unknown as ArtifactSnapshot;
    const checkpointVolumeVersions =
      checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

    return {
      conversationId: checkpoint.conversationId,
      agentConfigId: originalRun.agentConfigId,
      agentConfig: agentConfigSnapshot.config,
      workingDir: this.extractWorkingDir(agentConfigSnapshot.config),
      conversationData: {
        cliAgentSessionId: conversation.cliAgentSessionId,
        cliAgentSessionHistory: conversation.cliAgentSessionHistory,
      },
      artifactName: checkpointArtifact.artifactName,
      artifactVersion: checkpointArtifact.artifactVersion,
      templateVars: agentConfigSnapshot.templateVars || {},
      volumeVersions: checkpointVolumeVersions?.versions,
      buildResumeArtifact: true,
    };
  }

  /**
   * Resolve session to ConversationResolution
   */
  private async resolveSession(
    sessionId: string,
    userId: string,
  ): Promise<ConversationResolution> {
    const session =
      await agentSessionService.getByIdWithConversation(sessionId);

    if (!session) {
      throw new NotFoundError("Agent session");
    }

    if (session.userId !== userId) {
      throw new UnauthorizedError(
        "Agent session does not belong to authenticated user",
      );
    }

    if (!session.conversation) {
      throw new NotFoundError(
        "Agent session has no conversation history to continue from",
      );
    }

    if (!session.conversationId) {
      throw new NotFoundError("Agent session has no conversation ID");
    }

    // Load agent config
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, session.agentConfigId))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
    }

    return {
      conversationId: session.conversationId,
      agentConfigId: session.agentConfigId,
      agentConfig: config.config,
      workingDir: this.extractWorkingDir(config.config),
      conversationData: {
        cliAgentSessionId: session.conversation.cliAgentSessionId,
        cliAgentSessionHistory: session.conversation.cliAgentSessionHistory,
      },
      artifactName: session.artifactName,
      artifactVersion: "latest",
      templateVars: session.templateVars || {},
      volumeVersions: undefined,
      buildResumeArtifact: true,
    };
  }

  /**
   * Resolve direct conversation to ConversationResolution
   */
  private async resolveDirectConversation(
    conversationId: string,
    agentConfigId: string,
    userId: string,
  ): Promise<ConversationResolution> {
    // Load conversation
    const [conversation] = await globalThis.services.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) {
      throw new NotFoundError("Conversation");
    }

    // Verify conversation belongs to user
    const [originalRun] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, conversation.runId), eq(agentRuns.userId, userId)),
      )
      .limit(1);

    if (!originalRun) {
      throw new UnauthorizedError(
        "Conversation does not belong to authenticated user",
      );
    }

    // Load agent config
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, agentConfigId))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
    }

    return {
      conversationId,
      agentConfigId,
      agentConfig: config.config,
      workingDir: this.extractWorkingDir(config.config),
      conversationData: {
        cliAgentSessionId: conversation.cliAgentSessionId,
        cliAgentSessionHistory: conversation.cliAgentSessionHistory,
      },
      // No defaults for artifact/templateVars/volumeVersions - use params directly
      buildResumeArtifact: false,
    };
  }

  /**
   * Create execution context for a new run
   *
   * @param runId Run ID
   * @param agentConfigId Agent configuration ID
   * @param prompt User prompt
   * @param sandboxToken Temporary bearer token for sandbox
   * @param templateVars Template variable replacements
   * @param agentConfig Full agent configuration
   * @param userId User ID for volume access
   * @param artifactName Artifact storage name (required)
   * @param artifactVersion Artifact version (optional, defaults to "latest")
   * @returns Execution context for e2b-service
   */
  async createRunContext(
    runId: string,
    agentConfigId: string,
    prompt: string,
    sandboxToken: string,
    templateVars: Record<string, string> | undefined,
    agentConfig: unknown,
    userId?: string,
    artifactName?: string,
    artifactVersion?: string,
  ): Promise<ExecutionContext> {
    log.debug(`Creating run context for ${runId}`);

    return {
      runId,
      agentConfigId,
      agentConfig,
      prompt,
      templateVars,
      sandboxToken,
      userId,
      artifactName,
      artifactVersion,
    };
  }

  /**
   * Validate a checkpoint for resume operation
   * Returns checkpoint data without creating full execution context
   *
   * @param checkpointId Checkpoint ID to validate
   * @param userId User ID for authorization check
   * @returns Checkpoint data with agentConfigId
   * @throws NotFoundError if checkpoint doesn't exist
   * @throws UnauthorizedError if checkpoint doesn't belong to user
   */
  async validateCheckpoint(
    checkpointId: string,
    userId: string,
  ): Promise<{
    agentConfigId: string;
  }> {
    log.debug(`Validating checkpoint ${checkpointId} for user ${userId}`);

    // Load checkpoint from database
    const [checkpoint] = await globalThis.services.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, checkpointId))
      .limit(1);

    if (!checkpoint) {
      throw new NotFoundError("Checkpoint");
    }

    // Verify checkpoint belongs to user by checking the associated run
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

    log.debug(
      `Checkpoint validated: agentConfigId=${originalRun.agentConfigId}`,
    );

    return {
      agentConfigId: originalRun.agentConfigId,
    };
  }

  /**
   * Validate an agent session for continue operation
   * Returns session data without creating full execution context
   *
   * @param agentSessionId Agent session ID to validate
   * @param userId User ID for authorization check
   * @returns Session data with agentConfigId and templateVars
   * @throws NotFoundError if session doesn't exist
   * @throws UnauthorizedError if session doesn't belong to user
   */
  async validateAgentSession(
    agentSessionId: string,
    userId: string,
  ): Promise<{
    agentConfigId: string;
    templateVars: Record<string, string> | null;
  }> {
    log.debug(`Validating agent session ${agentSessionId} for user ${userId}`);

    // Load session with conversation data
    const session =
      await agentSessionService.getByIdWithConversation(agentSessionId);

    if (!session) {
      throw new NotFoundError("Agent session");
    }

    // Verify session belongs to user
    if (session.userId !== userId) {
      throw new UnauthorizedError(
        "Agent session does not belong to authenticated user",
      );
    }

    // Session must have a conversation to continue from
    if (!session.conversation) {
      throw new NotFoundError(
        "Agent session has no conversation history to continue from",
      );
    }

    log.debug(`Session validated: agentConfigId=${session.agentConfigId}`);

    return {
      agentConfigId: session.agentConfigId,
      templateVars: session.templateVars,
    };
  }

  /**
   * Build unified execution context from various parameter sources
   * Supports: new run, checkpoint resume, session continue
   *
   * Parameter expansion:
   * - checkpointId: Expands to checkpoint snapshot (config, conversation, artifact, volumes)
   * - sessionId: Expands to session data (config, conversation, artifact=latest)
   * - Explicit parameters override expanded values
   *
   * @param params Unified run parameters
   * @returns Execution context for e2b-service
   */
  async buildExecutionContext(params: {
    // Shortcuts (mutually exclusive)
    checkpointId?: string;
    sessionId?: string;
    // Base parameters
    agentConfigId?: string;
    conversationId?: string;
    artifactName?: string;
    artifactVersion?: string;
    templateVars?: Record<string, string>;
    volumeVersions?: Record<string, string>;
    // Required
    prompt: string;
    runId: string;
    sandboxToken: string;
    userId: string;
    // Metadata for vm0_start event
    agentName?: string;
    resumedFromCheckpointId?: string;
    continuedFromSessionId?: string;
  }): Promise<ExecutionContext> {
    log.debug(`Building execution context for ${params.runId}`);
    log.debug(`params.volumeVersions=${JSON.stringify(params.volumeVersions)}`);

    // Initialize context variables
    let agentConfigId: string | undefined = params.agentConfigId;
    let agentConfig: unknown;
    let artifactName: string | undefined = params.artifactName;
    let artifactVersion: string | undefined = params.artifactVersion;
    let templateVars: Record<string, string> | undefined = params.templateVars;
    let volumeVersions: Record<string, string> | undefined =
      params.volumeVersions;
    let resumeSession: ResumeSession | undefined;
    let resumeArtifact: ArtifactSnapshot | undefined;

    // Step 1: Resolve to conversation (unified path for checkpoint/session/direct)
    let resolution: ConversationResolution | undefined;

    if (params.checkpointId) {
      log.debug(`Resolving checkpoint ${params.checkpointId}`);
      resolution = await this.resolveCheckpoint(
        params.checkpointId,
        params.userId,
      );
    } else if (params.sessionId) {
      log.debug(`Resolving session ${params.sessionId}`);
      resolution = await this.resolveSession(params.sessionId, params.userId);
    } else if (params.conversationId && params.agentConfigId) {
      log.debug(`Resolving conversation ${params.conversationId}`);
      resolution = await this.resolveDirectConversation(
        params.conversationId,
        params.agentConfigId,
        params.userId,
      );
    }

    // Step 2: Apply resolution defaults and build resumeSession (unified path)
    if (resolution) {
      // Apply defaults (params override resolution values)
      agentConfigId = agentConfigId || resolution.agentConfigId;
      agentConfig = resolution.agentConfig;
      artifactName = artifactName || resolution.artifactName;
      artifactVersion = artifactVersion || resolution.artifactVersion;
      templateVars = templateVars || resolution.templateVars;
      volumeVersions = volumeVersions || resolution.volumeVersions;

      // Build resumeSession from resolution (single place!)
      resumeSession = {
        sessionId: resolution.conversationData.cliAgentSessionId,
        sessionHistory: resolution.conversationData.cliAgentSessionHistory,
        workingDir: resolution.workingDir,
      };

      // Build resumeArtifact if applicable
      if (resolution.buildResumeArtifact && artifactName) {
        resumeArtifact = {
          artifactName,
          artifactVersion: artifactVersion || "latest",
        };
      }

      log.debug(
        `Resolution applied: artifact=${artifactName}@${artifactVersion}`,
      );
    }
    // Step 3: New run - load agent config if agentConfigId provided (no conversation)
    else if (agentConfigId) {
      const [config] = await globalThis.services.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, agentConfigId))
        .limit(1);

      if (!config) {
        throw new NotFoundError("Agent config");
      }

      agentConfig = config.config;
    }

    // Validate required fields
    if (!agentConfigId) {
      throw new NotFoundError(
        "Agent config ID is required (provide agentConfigId, checkpointId, or sessionId)",
      );
    }

    if (!agentConfig) {
      throw new NotFoundError("Agent config could not be loaded");
    }

    // Build final execution context
    return {
      runId: params.runId,
      userId: params.userId,
      agentConfigId,
      agentConfig,
      prompt: params.prompt,
      templateVars,
      sandboxToken: params.sandboxToken,
      artifactName,
      artifactVersion,
      volumeVersions,
      resumeSession,
      resumeArtifact,
      // Metadata for vm0_start event
      agentName: params.agentName,
      resumedFromCheckpointId: params.resumedFromCheckpointId,
      continuedFromSessionId: params.continuedFromSessionId,
    };
  }

  /**
   * Execute an agent run with the given context
   * Delegates to e2b-service for actual execution
   *
   * @param context Execution context (new run or resume)
   * @returns Run result
   */
  async executeRun(context: ExecutionContext): Promise<RunResult> {
    log.debug(
      `Executing run ${context.runId} (resume: ${!!context.resumeSession})`,
    );
    return await e2bService.execute(context);
  }
}

// Export singleton instance
export const runService = new RunService();
