import { eq, and } from "drizzle-orm";
import { agentConfigs } from "../../db/schema/agent-config";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import { NotFoundError, UnauthorizedError } from "../errors";
import type { ExecutionContext, ResumeSession } from "./types";
import type { VolumeSnapshot } from "../checkpoint/types";
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
   * @param dynamicVars Dynamic variable replacements
   * @param agentConfig Full agent configuration
   * @returns Execution context for e2b-service
   */
  async createRunContext(
    runId: string,
    agentConfigId: string,
    prompt: string,
    sandboxToken: string,
    dynamicVars: Record<string, string> | undefined,
    agentConfig: unknown,
    userId?: string,
  ): Promise<ExecutionContext> {
    console.log(`[RunService] Creating run context for ${runId}`);

    return {
      runId,
      agentConfigId,
      agentConfig,
      prompt,
      dynamicVars,
      sandboxToken,
      userId,
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

    console.log(
      `[RunService] Checkpoint verified for user ${userId}, agent config ${checkpoint.agentConfigId}`,
    );

    // Load agent config
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, checkpoint.agentConfigId))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
    }

    console.log(
      `[RunService] Loaded agent config: ${config.name || config.id}`,
    );

    // Extract working directory from agent config
    const agentConfig = config.config as
      | { agent?: { working_dir?: string } }
      | undefined;
    const workingDir = agentConfig?.agent?.working_dir || "/workspace";

    console.log(`[RunService] Working directory: ${workingDir}`);

    // Build resume session data
    const resumeSession: ResumeSession = {
      sessionId: checkpoint.sessionId,
      sessionHistory: checkpoint.sessionHistory,
      workingDir,
    };

    // Parse volume snapshots from JSONB
    const resumeVolumes =
      (checkpoint.volumeSnapshots as unknown as VolumeSnapshot[]) || [];

    console.log(
      `[RunService] Resume session: ${checkpoint.sessionId}, volumes: ${resumeVolumes.length}`,
    );

    return {
      runId,
      userId,
      agentConfigId: checkpoint.agentConfigId,
      agentConfig: config.config,
      prompt,
      dynamicVars: (checkpoint.dynamicVars as Record<string, string>) || {},
      sandboxToken,
      resumeSession,
      resumeVolumes,
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
