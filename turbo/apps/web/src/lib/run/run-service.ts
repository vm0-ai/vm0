import { eq, and, count, gt, or } from "drizzle-orm";
import { isSelfHosted } from "../../env";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import {
  notFound,
  unauthorized,
  badRequest,
  concurrentRunLimit,
} from "../errors";
import { logger } from "../logger";
import type { ExecutionContext } from "./types";
import type { AgentComposeSnapshot } from "../checkpoint/types";
import { getAgentSessionWithConversation } from "../agent-session";
import { prepareForExecution } from "./context/execution-preparer";
import { executeE2bRun } from "./executors/e2b-executor";
import { executeRunnerJob } from "./executors/runner-executor";
import { executeDockerRun } from "./executors/docker-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import {
  buildExecutionContext as buildContext,
  type BuildContextParams,
} from "./build-context";

const log = logger("service:run");

// Defense-in-depth: exclude pending runs older than this from concurrency check.
// The cleanup-sandboxes cron job already transitions pending runs to "timeout" after 5 minutes,
// so this TTL only matters if the cron job fails to run.
const PENDING_RUN_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Re-export for backward compatibility
export { calculateSessionHistoryPath } from "./utils/session-history-path";

/**
 * Check if user has reached concurrent run limit
 *
 * @param userId User ID to check
 * @param limit Maximum allowed concurrent runs (default: 1, or CONCURRENT_RUN_LIMIT env var, 0 = no limit)
 * @throws ConcurrentRunLimitError if limit exceeded
 */
export async function checkRunConcurrencyLimit(
  userId: string,
  limit?: number,
): Promise<void> {
  // Use provided limit, or env var, or default to 1
  // Note: 0 means no limit, so we need explicit undefined check
  const rawEnvLimit = process.env.CONCURRENT_RUN_LIMIT;
  const envLimit =
    rawEnvLimit !== undefined && rawEnvLimit !== ""
      ? parseInt(rawEnvLimit, 10)
      : undefined;
  let effectiveLimit = 1; // Default

  if (limit !== undefined) {
    effectiveLimit = limit;
  } else if (envLimit !== undefined && !isNaN(envLimit)) {
    effectiveLimit = envLimit;
  }

  // Skip check if limit is 0 (no limit)
  if (effectiveLimit === 0) {
    return;
  }

  // Count active runs: all "running" runs + "pending" runs within TTL
  const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);

  const [result] = await globalThis.services.db
    .select({ count: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            gt(agentRuns.createdAt, staleThreshold),
          ),
        ),
      ),
    );

  const activeRunCount = Number(result?.count ?? 0);

  if (activeRunCount >= effectiveLimit) {
    log.debug(
      `User ${userId} has ${activeRunCount} active runs, limit is ${effectiveLimit}`,
    );
    throw concurrentRunLimit();
  }
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
export async function validateCheckpoint(
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
    throw notFound("Checkpoint not found");
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
    throw unauthorized("Checkpoint does not belong to authenticated user");
  }

  // Get version ID from snapshot
  const agentComposeSnapshot =
    checkpoint.agentComposeSnapshot as unknown as AgentComposeSnapshot;

  const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
  if (!agentComposeVersionId) {
    throw badRequest("Invalid checkpoint: missing agentComposeVersionId");
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
 * @returns Session data with agentComposeId
 * @throws NotFoundError if session doesn't exist
 * @throws UnauthorizedError if session doesn't belong to user
 */
export async function validateAgentSession(
  agentSessionId: string,
  userId: string,
): Promise<{
  agentComposeId: string;
}> {
  log.debug(`Validating agent session ${agentSessionId} for user ${userId}`);

  // Load session with conversation data
  const session = await getAgentSessionWithConversation(agentSessionId);

  if (!session) {
    throw notFound("Agent session not found");
  }

  // Verify session belongs to user
  if (session.userId !== userId) {
    throw unauthorized("Agent session does not belong to authenticated user");
  }

  // Session must have a conversation to continue from
  if (!session.conversation) {
    throw notFound(
      "Agent session has no conversation history to continue from",
    );
  }

  log.debug(`Session validated: agentComposeId=${session.agentComposeId}`);

  return {
    agentComposeId: session.agentComposeId,
  };
}

/**
 * Build unified execution context from various parameter sources
 * Supports: new run, checkpoint resume, session continue
 *
 * @param params Unified run parameters
 * @returns Execution context for executors
 */
export async function buildExecutionContext(
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
export async function prepareAndDispatchRun(
  context: ExecutionContext,
): Promise<ExecutorResult> {
  log.debug(`Preparing and dispatching run ${context.runId}...`);

  // Layer 1: Prepare context (storage manifest, working dir, etc.)
  const preparedContext = await prepareForExecution(context);

  // Layer 2: Dispatch to appropriate executor
  return await dispatchRun(preparedContext);
}

/**
 * Dispatch prepared context to appropriate executor
 *
 * Routing priority: Runner Group > E2B > Docker
 *
 * @param context PreparedContext ready for execution
 * @returns ExecutorResult with status and optional sandboxId
 */
async function dispatchRun(context: PreparedContext): Promise<ExecutorResult> {
  if (context.runnerGroup) {
    log.debug(
      `Dispatching run ${context.runId} to runner group: ${context.runnerGroup}`,
    );
    return await executeRunnerJob(context);
  } else if (isSelfHosted) {
    log.debug(`Dispatching run ${context.runId} to Docker executor`);
    return await executeDockerRun(context);
  } else {
    log.debug(`Dispatching run ${context.runId} to E2B executor`);
    return await executeE2bRun(context);
  }
}
