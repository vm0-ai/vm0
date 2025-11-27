import { eq, and } from "drizzle-orm";
import { checkpoints } from "../../db/schema/checkpoint";
import { conversations } from "../../db/schema/conversation";
import { agentRuns } from "../../db/schema/agent-run";
import { agentConfigs } from "../../db/schema/agent-config";
import { NotFoundError, UnauthorizedError } from "../errors";
import type { ExecutionContext, ResumeSession } from "./types";
import type {
  ArtifactSnapshot,
  AgentConfigSnapshot,
} from "../checkpoint/types";
import { agentSessionService } from "../agent-session";
import { e2bService } from "../e2b";
import type { RunResult } from "../e2b/types";

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
    console.log(`[RunService] Creating run context for ${runId}`);

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
    console.log(
      `[RunService] Creating resume context for ${runId} from checkpoint ${checkpointId}`,
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

    console.log(
      `[RunService] Checkpoint verified for user ${userId}, loaded conversation ${conversation.id}`,
    );

    // Extract working directory from agent config snapshot
    const agentConfig = agentConfigSnapshot.config as
      | { agents?: Array<{ working_dir?: string }> }
      | undefined;
    const workingDir = agentConfig?.agents?.[0]?.working_dir || "/workspace";

    console.log(`[RunService] Working directory: ${workingDir}`);

    // Build resume session data from conversation
    const resumeSession: ResumeSession = {
      sessionId: conversation.cliAgentSessionId,
      sessionHistory: conversation.cliAgentSessionHistory,
      workingDir,
    };

    // Parse artifact snapshot from JSONB
    const resumeArtifact =
      checkpoint.artifactSnapshot as unknown as ArtifactSnapshot;

    console.log(
      `[RunService] Resume session: ${conversation.cliAgentSessionId}, artifact: ${resumeArtifact.artifactName}@${resumeArtifact.artifactVersion}`,
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
    console.log(
      `[RunService] Validating agent session ${agentSessionId} for user ${userId}`,
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

    console.log(
      `[RunService] Session validated: agentConfigId=${session.agentConfigId}`,
    );

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
    console.log(
      `[RunService] Creating continue context for ${runId} from session ${agentSessionId}`,
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

    console.log(
      `[RunService] Session verified for user ${userId}, loaded conversation ${session.conversationId}`,
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

    console.log(`[RunService] Working directory: ${workingDir}`);

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

    console.log(
      `[RunService] Continue session: ${session.conversation.cliAgentSessionId}, artifact: ${resumeArtifact.artifactName}@latest`,
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
   * Execute an agent run with the given context
   * Delegates to e2b-service for actual execution
   *
   * @param context Execution context (new run or resume)
   * @returns Run result
   */
  async executeRun(context: ExecutionContext): Promise<RunResult> {
    console.log(
      `[RunService] Executing run ${context.runId} (resume: ${!!context.resumeSession})`,
    );
    return await e2bService.execute(context);
  }
}

// Export singleton instance
export const runService = new RunService();
