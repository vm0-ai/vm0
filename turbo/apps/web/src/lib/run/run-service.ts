import { eq, and } from "drizzle-orm";
import { checkpoints } from "../../db/schema/checkpoint";
import { conversations } from "../../db/schema/conversation";
import { agentRuns } from "../../db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { NotFoundError, UnauthorizedError, BadRequestError } from "../errors";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession } from "./types";
import type {
  ArtifactSnapshot,
  AgentComposeSnapshot,
  VolumeVersionsSnapshot,
} from "../checkpoint/types";
import { agentSessionService } from "../agent-session";
import { e2bService } from "../e2b";
import type { RunResult } from "../e2b/types";
import type { AgentComposeYaml } from "../../types/agent-compose";

const log = logger("service:run");

/**
 * Intermediate resolution result from checkpoint/session/conversation expansion
 * Contains all data needed to build resumeSession uniformly
 */
interface ConversationResolution {
  conversationId: string;
  agentComposeVersionId: string;
  agentCompose: unknown;
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
   * Throws BadRequestError if working_dir is not configured
   */
  private extractWorkingDir(config: unknown): string {
    const compose = config as AgentComposeYaml | undefined;
    if (!compose?.agents) {
      throw new BadRequestError(
        "Agent compose must have agents configured with working_dir",
      );
    }
    const agents = Object.values(compose.agents);
    const firstAgent = agents[0];
    if (!firstAgent?.working_dir) {
      throw new BadRequestError(
        "Agent must have working_dir configured (no default allowed)",
      );
    }
    return firstAgent.working_dir;
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
    const agentComposeSnapshot =
      checkpoint.agentComposeSnapshot as unknown as AgentComposeSnapshot;
    const checkpointArtifact =
      checkpoint.artifactSnapshot as unknown as ArtifactSnapshot;
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
      throw new NotFoundError(`Agent compose version ${agentComposeVersionId}`);
    }
    const agentCompose = version.content as AgentComposeYaml;

    return {
      conversationId: checkpoint.conversationId,
      agentComposeVersionId,
      agentCompose,
      workingDir: this.extractWorkingDir(agentCompose),
      conversationData: {
        cliAgentSessionId: conversation.cliAgentSessionId,
        cliAgentSessionHistory: conversation.cliAgentSessionHistory,
      },
      artifactName: checkpointArtifact.artifactName,
      artifactVersion: checkpointArtifact.artifactVersion,
      templateVars: agentComposeSnapshot.templateVars || {},
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

    // Load agent compose
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, session.agentComposeId))
      .limit(1);

    if (!compose) {
      throw new NotFoundError("Agent compose");
    }

    if (!compose.headVersionId) {
      throw new BadRequestError(
        "Agent compose has no versions. Run 'vm0 build' first.",
      );
    }

    // Get HEAD version content
    const [version] = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (!version) {
      throw new NotFoundError("Agent compose version");
    }

    return {
      conversationId: session.conversationId,
      agentComposeVersionId: compose.headVersionId,
      agentCompose: version.content,
      workingDir: this.extractWorkingDir(version.content),
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
    agentComposeVersionId: string,
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

    // Load agent compose version
    const [version] = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, agentComposeVersionId))
      .limit(1);

    if (!version) {
      throw new NotFoundError("Agent compose version");
    }

    return {
      conversationId,
      agentComposeVersionId,
      agentCompose: version.content,
      workingDir: this.extractWorkingDir(version.content),
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
   * @param agentComposeVersionId Agent compose version ID (SHA-256 hash)
   * @param prompt User prompt
   * @param sandboxToken Temporary bearer token for sandbox
   * @param templateVars Template variable replacements
   * @param agentCompose Full agent compose
   * @param userId User ID for volume access
   * @param artifactName Artifact storage name (required)
   * @param artifactVersion Artifact version (optional, defaults to "latest")
   * @returns Execution context for e2b-service
   */
  async createRunContext(
    runId: string,
    agentComposeVersionId: string,
    prompt: string,
    sandboxToken: string,
    templateVars: Record<string, string> | undefined,
    agentCompose: unknown,
    userId?: string,
    artifactName?: string,
    artifactVersion?: string,
  ): Promise<ExecutionContext> {
    log.debug(`Creating run context for ${runId}`);

    return {
      runId,
      agentComposeVersionId,
      agentCompose,
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
   * @returns Checkpoint data with agentComposeVersionId
   * @throws NotFoundError if checkpoint doesn't exist
   * @throws UnauthorizedError if checkpoint doesn't belong to user
   */
  async validateCheckpoint(
    checkpointId: string,
    userId: string,
  ): Promise<{
    agentComposeVersionId: string;
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

    // Get version ID from snapshot
    const agentComposeSnapshot =
      checkpoint.agentComposeSnapshot as unknown as AgentComposeSnapshot;

    const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
    if (!agentComposeVersionId) {
      throw new BadRequestError(
        "Invalid checkpoint: missing agentComposeVersionId",
      );
    }

    log.debug(
      `Checkpoint validated: agentComposeVersionId=${agentComposeVersionId}`,
    );

    return {
      agentComposeVersionId,
    };
  }

  /**
   * Validate an agent session for continue operation
   * Returns session data without creating full execution context
   *
   * @param agentSessionId Agent session ID to validate
   * @param userId User ID for authorization check
   * @returns Session data with agentComposeId and templateVars
   * @throws NotFoundError if session doesn't exist
   * @throws UnauthorizedError if session doesn't belong to user
   */
  async validateAgentSession(
    agentSessionId: string,
    userId: string,
  ): Promise<{
    agentComposeId: string;
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

    log.debug(`Session validated: agentComposeId=${session.agentComposeId}`);

    return {
      agentComposeId: session.agentComposeId,
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
    agentComposeVersionId?: string;
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
    let agentComposeVersionId: string | undefined =
      params.agentComposeVersionId;
    let agentCompose: unknown;
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
    } else if (params.conversationId && params.agentComposeVersionId) {
      log.debug(`Resolving conversation ${params.conversationId}`);
      resolution = await this.resolveDirectConversation(
        params.conversationId,
        params.agentComposeVersionId,
        params.userId,
      );
    }

    // Step 2: Apply resolution defaults and build resumeSession (unified path)
    if (resolution) {
      // Apply defaults (params override resolution values)
      agentComposeVersionId =
        agentComposeVersionId || resolution.agentComposeVersionId;
      agentCompose = resolution.agentCompose;
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
    // Step 3: New run - load agent compose version if agentComposeVersionId provided (no conversation)
    else if (agentComposeVersionId) {
      const [version] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, agentComposeVersionId))
        .limit(1);

      if (!version) {
        throw new NotFoundError("Agent compose version");
      }

      agentCompose = version.content;
    }

    // Validate required fields
    if (!agentComposeVersionId) {
      throw new NotFoundError(
        "Agent compose version ID is required (provide agentComposeVersionId, checkpointId, or sessionId)",
      );
    }

    if (!agentCompose) {
      throw new NotFoundError("Agent compose could not be loaded");
    }

    // Build final execution context
    return {
      runId: params.runId,
      userId: params.userId,
      agentComposeVersionId,
      agentCompose,
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
