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
   * Create execution context for resuming from a checkpoint
   *
   * @param runId New run ID for the resume
   * @param checkpointId Checkpoint ID to resume from
   * @param prompt New prompt for resumed execution
   * @param sandboxToken Temporary bearer token for sandbox
   * @param userId User ID for authorization check
   * @returns Execution context for e2b-service
   * @throws NotFoundError if checkpoint doesn't exist
   * @throws UnauthorizedError if checkpoint doesn't belong to user
   */
  async createResumeContext(
    runId: string,
    checkpointId: string,
    prompt: string,
    sandboxToken: string,
    userId: string,
  ): Promise<ExecutionContext> {
    log.debug(
      `Creating resume context for ${runId} from checkpoint ${checkpointId}`,
    );

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

    // Load conversation from database
    const [conversation] = await globalThis.services.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, checkpoint.conversationId))
      .limit(1);

    if (!conversation) {
      throw new NotFoundError("Conversation");
    }

    // Extract agent config snapshot
    const agentConfigSnapshot =
      checkpoint.agentConfigSnapshot as unknown as AgentConfigSnapshot;

    log.debug(
      `Checkpoint verified for user ${userId}, loaded conversation ${conversation.id}`,
    );

    // Extract working directory from agent config snapshot
    const agentConfig = agentConfigSnapshot.config as
      | { agents?: Array<{ working_dir?: string }> }
      | undefined;
    const workingDir = agentConfig?.agents?.[0]?.working_dir || "/workspace";

    log.debug(`Working directory: ${workingDir}`);

    // Build resume session data from conversation
    const resumeSession: ResumeSession = {
      sessionId: conversation.cliAgentSessionId,
      sessionHistory: conversation.cliAgentSessionHistory,
      workingDir,
    };

    // Parse artifact snapshot from JSONB
    const resumeArtifact =
      checkpoint.artifactSnapshot as unknown as ArtifactSnapshot;

    // Parse volume versions snapshot if present
    const volumeVersionsSnapshot =
      checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

    log.debug(
      `Resume session: ${conversation.cliAgentSessionId}, artifact: ${resumeArtifact.artifactName}@${resumeArtifact.artifactVersion}`,
    );

    return {
      runId,
      userId,
      agentConfigId: originalRun.agentConfigId,
      agentConfig: agentConfigSnapshot.config,
      prompt,
      templateVars: agentConfigSnapshot.templateVars || {},
      sandboxToken,
      resumeSession,
      resumeArtifact,
      volumeVersions: volumeVersionsSnapshot?.versions,
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
   * Create execution context for continuing from an agent session
   * Unlike checkpoint resume, this uses the LATEST artifact version
   *
   * @param runId New run ID for the continue
   * @param agentSessionId Agent session ID to continue from
   * @param prompt New prompt for continued execution
   * @param sandboxToken Temporary bearer token for sandbox
   * @param userId User ID for authorization check
   * @returns Execution context for e2b-service
   * @throws NotFoundError if session doesn't exist
   * @throws UnauthorizedError if session doesn't belong to user
   */
  async createContinueContext(
    runId: string,
    agentSessionId: string,
    prompt: string,
    sandboxToken: string,
    userId: string,
  ): Promise<ExecutionContext> {
    log.debug(
      `Creating continue context for ${runId} from session ${agentSessionId}`,
    );

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

    log.debug(
      `Session verified for user ${userId}, loaded conversation ${session.conversationId}`,
    );

    // Load agent config for working directory
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, session.agentConfigId))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
    }

    // Extract working directory from agent config
    const agentConfig = config.config as
      | { agents?: Array<{ working_dir?: string }> }
      | undefined;
    const workingDir = agentConfig?.agents?.[0]?.working_dir || "/workspace";

    log.debug(`Working directory: ${workingDir}`);

    // Build resume session data from conversation
    const resumeSession: ResumeSession = {
      sessionId: session.conversation.cliAgentSessionId,
      sessionHistory: session.conversation.cliAgentSessionHistory,
      workingDir,
    };

    // For continue, use LATEST artifact version (not a snapshot)
    // This is the key difference from checkpoint resume
    const resumeArtifact: ArtifactSnapshot = {
      artifactName: session.artifactName,
      artifactVersion: "latest", // Always use latest for continue
    };

    log.debug(
      `Continue session: ${session.conversation.cliAgentSessionId}, artifact: ${resumeArtifact.artifactName}@latest`,
    );

    return {
      runId,
      userId,
      agentConfigId: session.agentConfigId,
      agentConfig: config.config,
      prompt,
      templateVars: session.templateVars || {},
      sandboxToken,
      resumeSession,
      resumeArtifact,
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
    // Note: conversationId is stored with new runs but not used in buildExecutionContext
    // It is used by the API endpoint when creating run records
    let artifactName: string | undefined = params.artifactName;
    let artifactVersion: string | undefined = params.artifactVersion;
    let templateVars: Record<string, string> | undefined = params.templateVars;
    let volumeVersions: Record<string, string> | undefined =
      params.volumeVersions;
    let resumeSession: ResumeSession | undefined;
    let resumeArtifact: ArtifactSnapshot | undefined;

    // Step 1: Expand checkpoint if provided
    if (params.checkpointId) {
      log.debug(`Expanding checkpoint ${params.checkpointId}`);

      const [checkpoint] = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.id, params.checkpointId))
        .limit(1);

      if (!checkpoint) {
        throw new NotFoundError("Checkpoint");
      }

      // Verify checkpoint belongs to user
      const [originalRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, checkpoint.runId),
            eq(agentRuns.userId, params.userId),
          ),
        )
        .limit(1);

      if (!originalRun) {
        throw new UnauthorizedError(
          "Checkpoint does not belong to authenticated user",
        );
      }

      // Load conversation for session history
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

      // Set defaults from checkpoint (can be overridden)
      agentConfigId = agentConfigId || originalRun.agentConfigId;
      agentConfig = agentConfigSnapshot.config;
      // Note: checkpoint.conversationId is used internally for resumeSession
      artifactName = artifactName || checkpointArtifact.artifactName;
      artifactVersion = artifactVersion || checkpointArtifact.artifactVersion;
      templateVars = templateVars || agentConfigSnapshot.templateVars || {};
      volumeVersions = volumeVersions || checkpointVolumeVersions?.versions;

      // Extract working directory for resume session
      const configWithAgents = agentConfigSnapshot.config as
        | { agents?: Array<{ working_dir?: string }> }
        | undefined;
      const workingDir =
        configWithAgents?.agents?.[0]?.working_dir || "/workspace";

      // Build resume session from conversation
      resumeSession = {
        sessionId: conversation.cliAgentSessionId,
        sessionHistory: conversation.cliAgentSessionHistory,
        workingDir,
      };

      // Build resume artifact
      resumeArtifact = {
        artifactName: artifactName,
        artifactVersion: artifactVersion,
      };

      log.debug(
        `Checkpoint expanded: artifact=${artifactName}@${artifactVersion}`,
      );
    }
    // Step 2: Expand session if provided (mutually exclusive with checkpoint)
    else if (params.sessionId) {
      log.debug(`Expanding session ${params.sessionId}`);

      const session = await agentSessionService.getByIdWithConversation(
        params.sessionId,
      );

      if (!session) {
        throw new NotFoundError("Agent session");
      }

      if (session.userId !== params.userId) {
        throw new UnauthorizedError(
          "Agent session does not belong to authenticated user",
        );
      }

      if (!session.conversation) {
        throw new NotFoundError(
          "Agent session has no conversation history to continue from",
        );
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

      // Set defaults from session
      agentConfigId = agentConfigId || session.agentConfigId;
      agentConfig = config.config;
      // Note: session.conversationId is used internally for resumeSession
      artifactName = artifactName || session.artifactName;
      // Session always uses "latest" unless explicitly overridden
      artifactVersion = artifactVersion || "latest";
      templateVars = templateVars || session.templateVars || {};
      // Session does not have stored volume versions

      // Extract working directory
      const configWithAgents = config.config as
        | { agents?: Array<{ working_dir?: string }> }
        | undefined;
      const workingDir =
        configWithAgents?.agents?.[0]?.working_dir || "/workspace";

      // Build resume session from conversation
      resumeSession = {
        sessionId: session.conversation.cliAgentSessionId,
        sessionHistory: session.conversation.cliAgentSessionHistory,
        workingDir,
      };

      // Build resume artifact (always latest for session)
      resumeArtifact = {
        artifactName: artifactName,
        artifactVersion: "latest",
      };

      log.debug(`Session expanded: artifact=${artifactName}@latest`);
    }
    // Step 3: New run - load agent config if agentConfigId provided
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
