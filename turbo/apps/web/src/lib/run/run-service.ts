import { eq, and, count, inArray } from "drizzle-orm";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import {
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
  ConcurrentRunLimitError,
} from "../errors";
import { logger } from "../logger";
import type { ExecutionContext } from "./types";
import type { AgentComposeSnapshot } from "../checkpoint/types";
import { agentSessionService } from "../agent-session";
import { prepareForExecution } from "./context/execution-preparer";
import { e2bExecutor } from "./executors/e2b-executor";
import { runnerExecutor } from "./executors/runner-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import {
  buildExecutionContext as buildContext,
  type BuildContextParams,
} from "./build-context";

const log = logger("service:run");

// Re-export for backward compatibility
export { calculateSessionHistoryPath } from "./utils/session-history-path";

/**
 * Run Service
 * Thin wrapper that delegates to functional modules for building and dispatching agent runs
 */
export class RunService {
  /**
   * Create execution context for a new run
   * Legacy method - prefer buildExecutionContext for full functionality
   *
   * @param runId Run ID
   * @param agentComposeVersionId Agent compose version ID (SHA-256 hash)
   * @param prompt User prompt
   * @param sandboxToken Temporary bearer token for sandbox
   * @param vars Variable replacements
   * @param secrets Secret replacements (decrypted)
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
    vars: Record<string, string> | undefined,
    secrets: Record<string, string> | undefined,
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
      vars,
      secrets,
      sandboxToken,
      userId,
      artifactName,
      artifactVersion,
    };
  }

  /**
   * Validate a checkpoint for resume operation
   * Returns checkpoint data without creating full execution context
   * Note: secrets values are NEVER stored - only names for validation
   *
   * @param checkpointId Checkpoint ID to validate
   * @param userId User ID for authorization check
   * @returns Checkpoint data with agentComposeVersionId, vars, and secretNames
   * @throws NotFoundError if checkpoint doesn't exist
   * @throws UnauthorizedError if checkpoint doesn't belong to user
   */
  async validateCheckpoint(
    checkpointId: string,
    userId: string,
  ): Promise<{
    agentComposeVersionId: string;
    vars: Record<string, string> | null;
    secretNames: string[] | null;
  }> {
    log.debug(`Validating checkpoint ${checkpointId} for user ${userId}`);

    // Load checkpoint from database
    const [checkpoint] = await globalThis.services.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, checkpointId))
      .limit(1);

    if (!checkpoint) {
      throw new NotFoundError("Checkpoint not found");
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

    // Get vars from original run, secretNames from run (values are NEVER stored)
    const vars = (originalRun.vars as Record<string, string>) ?? null;
    const secretNames = (originalRun.secretNames as string[]) ?? null;

    return {
      agentComposeVersionId,
      vars,
      secretNames,
    };
  }

  /**
   * Validate an agent session for continue operation
   * Returns session data without creating full execution context
   * Note: secrets values are NEVER stored - only names for validation
   *
   * @param agentSessionId Agent session ID to validate
   * @param userId User ID for authorization check
   * @returns Session data with agentComposeId, vars, and secretNames
   * @throws NotFoundError if session doesn't exist
   * @throws UnauthorizedError if session doesn't belong to user
   */
  async validateAgentSession(
    agentSessionId: string,
    userId: string,
  ): Promise<{
    agentComposeId: string;
    agentComposeVersionId: string | null;
    vars: Record<string, string> | null;
    secretNames: string[] | null;
    volumeVersions: Record<string, string> | null;
  }> {
    log.debug(`Validating agent session ${agentSessionId} for user ${userId}`);

    // Load session with conversation data
    const session =
      await agentSessionService.getByIdWithConversation(agentSessionId);

    if (!session) {
      throw new NotFoundError("Agent session not found");
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
      `Session validated: agentComposeId=${session.agentComposeId}, agentComposeVersionId=${session.agentComposeVersionId}`,
    );

    return {
      agentComposeId: session.agentComposeId,
      agentComposeVersionId: session.agentComposeVersionId,
      vars: session.vars,
      secretNames: session.secretNames,
      volumeVersions: session.volumeVersions,
    };
  }

  /**
   * Build unified execution context from various parameter sources
   * Supports: new run, checkpoint resume, session continue
   *
   * Delegates to functional buildExecutionContext implementation.
   *
   * @param params Unified run parameters
   * @returns Execution context for executors
   */
  async buildExecutionContext(
    params: BuildContextParams,
  ): Promise<ExecutionContext> {
    return buildContext(params);
  }

  /**
   * Prepare execution context and dispatch to appropriate executor
   *
   * This is the unified entry point that handles both E2B and runner paths:
   * 1. Prepares the execution context (storage manifest, working dir, etc.)
   * 2. Routes to the appropriate executor based on runner group config
   *
   * @param context ExecutionContext built by buildExecutionContext()
   * @returns ExecutorResult with status and optional sandboxId
   */
  async prepareAndDispatch(context: ExecutionContext): Promise<ExecutorResult> {
    log.debug(`Preparing and dispatching run ${context.runId}...`);

    // Layer 1: Prepare context (storage manifest, working dir, etc.)
    const preparedContext = await prepareForExecution(context);

    // Layer 2: Dispatch to appropriate executor
    return await this.dispatch(preparedContext);
  }

  /**
   * Check if user has reached concurrent run limit
   *
   * @param userId User ID to check
   * @param limit Maximum allowed concurrent runs (default: 1, or CONCURRENT_RUN_LIMIT env var, 0 = no limit)
   * @throws ConcurrentRunLimitError if limit exceeded
   */
  async checkConcurrencyLimit(userId: string, limit?: number): Promise<void> {
    // Use provided limit, or env var, or default to 1
    // Note: 0 means no limit (for testing), so we need explicit undefined check
    const envLimit = process.env.CONCURRENT_RUN_LIMIT;
    let effectiveLimit = 1; // Default

    if (limit !== undefined) {
      effectiveLimit = limit;
    } else if (envLimit !== undefined) {
      const parsed = Number(envLimit);
      // Only use env var if it's a valid non-negative number
      if (!Number.isNaN(parsed) && parsed >= 0) {
        effectiveLimit = parsed;
      } else {
        log.warn(
          `Invalid CONCURRENT_RUN_LIMIT value "${envLimit}", using default of 1`,
        );
      }
    }

    // Skip check if limit is 0 (no limit)
    if (effectiveLimit === 0) {
      return;
    }

    const [result] = await globalThis.services.db
      .select({ count: count() })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userId, userId),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      );

    const activeRunCount = Number(result?.count ?? 0);

    if (activeRunCount >= effectiveLimit) {
      log.debug(
        `User ${userId} has ${activeRunCount} active runs, limit is ${effectiveLimit}`,
      );
      throw new ConcurrentRunLimitError();
    }
  }

  /**
   * Dispatch prepared context to appropriate executor
   *
   * @param context PreparedContext ready for execution
   * @returns ExecutorResult with status and optional sandboxId
   */
  async dispatch(context: PreparedContext): Promise<ExecutorResult> {
    if (context.runnerGroup) {
      log.debug(
        `Dispatching run ${context.runId} to runner group: ${context.runnerGroup}`,
      );
      return await runnerExecutor.execute(context);
    } else {
      log.debug(`Dispatching run ${context.runId} to E2B executor`);
      return await e2bExecutor.execute(context);
    }
  }
}

// Export singleton instance
export const runService = new RunService();
