import { eq, and, count, gt, or, sql } from "drizzle-orm";
import { env } from "../../env";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../db/schema/agent-compose";
import { agentRunCallbacks } from "../../db/schema/agent-run-callback";
import {
  notFound,
  unauthorized,
  badRequest,
  forbidden,
  concurrentRunLimit,
  isConcurrentRunLimit,
} from "../errors";
import { enqueueRun } from "./run-queue-service";
import { logger } from "../logger";
import type { Database } from "../../types/global";
import type { AgentComposeSnapshot } from "../checkpoint/types";
import type { AgentComposeYaml } from "../../types/agent-compose";
import { getAgentSessionWithConversation } from "../agent-session";
import { prepareForExecution } from "./context/execution-preparer";
import { executeE2bRun } from "./executors/e2b-executor";
import { executeRunnerJob } from "./executors/runner-executor";
import { executeDockerRun } from "./executors/docker-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import { buildExecutionContext as buildContext } from "./build-context";
import { generateSandboxToken } from "../auth/sandbox-token";
import { recordSandboxOperation } from "../metrics";
import { canAccessCompose } from "../agent/permission-service";
import { getUserEmail } from "../auth/get-user-email";
import { extractTemplateVars } from "../config-validator";

import { getUserScopeByClerkId } from "../scope/scope-service";
import { getDefaultScope } from "../scope/scope-member-service";
import { getVariableValues } from "../variable/variable-service";
import { encryptCredentialValue } from "../crypto/secrets-encryption";

const log = logger("service:run");

// Defense-in-depth: exclude pending runs older than this from concurrency check.
// The cleanup-sandboxes cron job already transitions pending runs to "timeout" after 5 minutes,
// so this TTL only matters if the cron job fails to run.
export const PENDING_RUN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if user has reached concurrent run limit
 *
 * @param userId User ID to check
 * @param limit Maximum allowed concurrent runs (default: 1, or CONCURRENT_RUN_LIMIT env var, 0 = no limit)
 * @throws ConcurrentRunLimitError if limit exceeded
 */
async function checkRunConcurrencyLimit(
  userId: string,
  limit?: number,
  db?: Database,
): Promise<void> {
  // Use provided limit, or env var, or default to 1
  // Note: 0 means no limit, so we need explicit undefined check
  const envLimit = env().CONCURRENT_RUN_LIMIT;
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

  const queryDb = db ?? globalThis.services.db;

  // Count active runs: all "running" runs + "pending" runs within TTL
  const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);

  const [result] = await queryDb
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
 * Dispatch prepared context to appropriate executor.
 *
 * Routing:
 * - Runner Group: explicit runner config in compose
 * - E2B: cloud mode, requires E2B_API_KEY
 * - Docker: local mode, requires DOCKER_SANDBOX_IMAGE
 *
 */
async function dispatchRun(context: PreparedContext): Promise<ExecutorResult> {
  if (context.runnerGroup) {
    log.debug(
      `Dispatching run ${context.runId} to runner group: ${context.runnerGroup}`,
    );
    return await executeRunnerJob(context);
  }

  // Domain-based rollout: route @vm0.ai users to runner.
  // Note: CI test accounts (e2e+clerk_test@vm0.ai) also match, but preview
  // deploys don't set RUNNER_DEFAULT_GROUP so they still use E2B.
  const defaultGroup = env().RUNNER_DEFAULT_GROUP;
  if (defaultGroup) {
    const email = await getUserEmail(context.userId);
    if (email.endsWith("@vm0.ai")) {
      log.debug(
        `Dispatching run ${context.runId} to runner (domain rollout: ${email})`,
      );
      return await executeRunnerJob({ ...context, runnerGroup: defaultGroup });
    }
  }

  if (env().E2B_API_KEY) {
    log.debug(`Dispatching run ${context.runId} to E2B executor`);
    return await executeE2bRun(context);
  } else if (env().DOCKER_SANDBOX_IMAGE) {
    log.debug(`Dispatching run ${context.runId} to Docker executor`);
    return await executeDockerRun(context);
  }

  throw new Error(
    "No executor configured: set E2B_API_KEY for cloud mode or DOCKER_SANDBOX_IMAGE for Docker mode",
  );
}

// ============================================================================
// Unified Run Creation
// ============================================================================

/**
 * Extended error type for dispatch failures that includes run metadata.
 * When createRun() fails after the run record is created (post-INSERT),
 * the error is augmented with runId and createdAt so callers can
 * return partial results if needed.
 */
export interface RunDispatchError extends Error {
  runId?: string;
  createdAt?: Date;
}

export interface CreateRunParams {
  // Required — every caller must provide
  userId: string;
  agentComposeVersionId: string;
  prompt: string;

  // Optional — caller-resolved compose ID
  // When provided, createRun() uses this to load the compose instead of
  // resolving via version.composeId. This avoids content-addressed version
  // collisions where version.composeId may point to a different user's compose.
  composeId?: string;

  // Optional — caller-specific
  sessionId?: string;
  checkpointId?: string;
  conversationId?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  artifactName?: string;
  artifactVersion?: string;
  volumeVersions?: Record<string, string>;
  scheduleId?: string;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  resumedFromCheckpointId?: string;
  agentName?: string;
  modelProvider?: string;
  debugNoMockClaude?: boolean;
  checkEnv?: boolean;
  // Caller-resolved scope ID for variable resolution (org-aware).
  // When provided, used instead of getUserScopeByClerkId fallback.
  scopeId?: string;
}

export interface CreateRunResult {
  runId: string;
  status: string;
  sandboxId?: string;
  createdAt: Date;
}

/**
 * Load compose version and compose metadata, then verify access.
 *
 * @returns composeContent and compose record
 * @throws NotFoundError - version or compose not found
 * @throws ForbiddenError - user cannot access compose
 */
async function loadAndAuthorizeCompose(
  userId: string,
  agentComposeVersionId: string,
  callerComposeId?: string,
): Promise<{
  composeContent: AgentComposeYaml;
  compose: { id: string; userId: string; scopeId: string | null };
}> {
  const [version] = await globalThis.services.db
    .select({
      id: agentComposeVersions.id,
      content: agentComposeVersions.content,
      composeId: agentComposeVersions.composeId,
    })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw notFound("Agent compose version not found");
  }

  const composeContent = version.content as AgentComposeYaml;

  // Use caller-provided composeId when available to avoid content-addressed
  // version collisions (version.composeId may point to a different user's compose)
  const resolvedComposeId = callerComposeId ?? version.composeId;

  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      scopeId: agentComposes.scopeId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, resolvedComposeId))
    .limit(1);

  if (!compose) {
    throw notFound("Agent compose not found");
  }

  const userEmail = await getUserEmail(userId);
  const hasAccess = await canAccessCompose(userId, userEmail, compose);
  if (!hasAccess) {
    throw forbidden("You do not have permission to access this agent");
  }

  return { composeContent, compose };
}

/**
 * Validate template vars availability and image access for new runs.
 *
 * Skipped when resuming from checkpoint or continuing a session.
 * Vars validation only runs when checkEnv is enabled (matching expand-environment.ts behavior).
 *
 * @throws BadRequestError - missing required template variables (only when checkEnv is true)
 */
async function validateComposeRequirements(
  userId: string,
  composeContent: AgentComposeYaml,
  vars?: Record<string, string>,
  checkEnv?: boolean,
  scopeId?: string,
): Promise<void> {
  if (!composeContent?.agents) {
    return;
  }

  // Only validate vars when checkEnv is enabled (matching expand-environment.ts behavior)
  if (checkEnv) {
    const requiredVars = extractTemplateVars(composeContent);
    if (requiredVars.length > 0) {
      const resolvedScopeId =
        scopeId ?? (await getUserScopeByClerkId(userId))?.id;
      const storedVars = resolvedScopeId
        ? await getVariableValues(resolvedScopeId, userId)
        : {};
      const allVars = { ...storedVars, ...vars };
      const missingVars = requiredVars.filter(
        (varName) => allVars[varName] === undefined,
      );
      if (missingVars.length > 0) {
        throw badRequest(
          `Missing required template variables: ${missingVars.join(", ")}`,
        );
      }
    }
  }
}

/**
 * Register run callbacks with encrypted secrets.
 */
async function registerCallbacks(
  runId: string,
  callbacks: Array<{ url: string; secret: string; payload: unknown }>,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  for (const callback of callbacks) {
    const encryptedSecret = encryptCredentialValue(
      callback.secret,
      SECRETS_ENCRYPTION_KEY,
    );
    await globalThis.services.db.insert(agentRunCallbacks).values({
      runId,
      url: callback.url,
      encryptedSecret,
      payload: callback.payload,
    });
  }
  log.debug(`Registered ${callbacks.length} callback(s) for run ${runId}`);
}

/**
 * Mark a run as failed and attach run metadata to the error for callers.
 */
async function markRunFailed(
  runId: string,
  createdAt: Date,
  error: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  log.error(`Run ${runId} failed: ${errorMessage}`);

  await globalThis.services.db
    .update(agentRuns)
    .set({
      status: "failed",
      error: errorMessage,
      completedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));

  // Attach run metadata so callers can return partial results
  if (error instanceof Error) {
    (error as RunDispatchError).runId = runId;
    (error as RunDispatchError).createdAt = createdAt;
  }
}

/**
 * Shared dispatch pipeline for steps 6-10 of the run creation flow.
 * Used by both createRun (new runs) and executeQueuedRun (dequeued runs).
 */
async function buildAndDispatchRun(opts: {
  runId: string;
  createdAt: Date;
  params: CreateRunParams;
  composeContent: AgentComposeYaml;
  apiStartTime: number;
  scopeId: string | undefined;
  authorizeTime: number;
  transactionTime: number;
}): Promise<{ status: string; sandboxId?: string }> {
  const {
    runId,
    createdAt,
    params,
    composeContent,
    apiStartTime,
    scopeId,
    authorizeTime,
    transactionTime,
  } = opts;
  const { userId, agentComposeVersionId, prompt } = params;

  try {
    // Register callbacks (if any)
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(runId, params.callbacks);
    }

    // Generate sandbox token
    const sandboxToken = await generateSandboxToken(userId, runId);
    const tokenTime = Date.now();

    // Build execution context
    const context = await buildContext({
      checkpointId: params.checkpointId,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      agentComposeVersionId,
      artifactName: params.artifactName,
      artifactVersion: params.artifactVersion,
      vars: params.vars,
      secrets: params.secrets,
      volumeVersions: params.volumeVersions,
      agentCompose: composeContent,
      prompt,
      runId,
      sandboxToken,
      userId,
      agentName: params.agentName,
      resumedFromCheckpointId: params.resumedFromCheckpointId,
      continuedFromSessionId: params.sessionId,
      debugNoMockClaude: params.debugNoMockClaude,
      modelProvider: params.modelProvider,
      checkEnv: params.checkEnv,
      apiStartTime,
      scopeId,
    });
    const buildContextTime = Date.now();

    // Prepare execution context (storage manifest, working dir, etc.)
    const preparedContext = await prepareForExecution(context);
    const prepareTime = Date.now();

    // Dispatch to executor
    const result = await dispatchRun(preparedContext);
    const dispatchTime = Date.now();

    // Record per-step timing metrics for latency diagnosis
    const steps = [
      { op: "api_step_authorize", ms: authorizeTime - apiStartTime },
      {
        op: "api_step_validate_and_insert",
        ms: transactionTime - authorizeTime,
      },
      { op: "api_step_callbacks_and_token", ms: tokenTime - transactionTime },
      { op: "api_step_build_context", ms: buildContextTime - tokenTime },
      { op: "api_step_prepare", ms: prepareTime - buildContextTime },
      { op: "api_step_dispatch", ms: dispatchTime - prepareTime },
    ];
    for (const step of steps) {
      recordSandboxOperation({
        sandboxType: result.sandboxType,
        actionType: step.op,
        durationMs: step.ms,
        success: true,
      });
    }

    log.debug(`Run ${runId} dispatched with status: ${result.status}`);
    return result;
  } catch (error) {
    await markRunFailed(runId, createdAt, error);
    throw error;
  }
}

/**
 * Unified run creation pipeline
 *
 * Validates, creates, and dispatches a run in a single call.
 * All callers (API Route, Schedule, Slack) should use this.
 *
 * Pipeline:
 * 1. Load compose version content + compose metadata
 * 2. Permission check (canAccessCompose)
 * 3. Validate template vars and image access
 * 4. Validate mutual exclusivity (checkpointId vs sessionId)
 * 5. Acquire per-user advisory lock, check concurrent run limit, INSERT agentRuns (atomic transaction)
 * 6. Register callbacks (if any)
 * 7. Generate sandbox token
 * 8. Build execution context
 * 9. Dispatch to executor
 *
 * @throws ForbiddenError - user cannot access compose
 * @throws BadRequestError - validation failure (missing vars, mutual exclusivity)
 * @throws NotFoundError - compose version not found
 * @throws Error - dispatch failure (run already marked as "failed")
 */
export async function createRun(
  params: CreateRunParams,
): Promise<CreateRunResult> {
  const apiStartTime = Date.now();
  const { userId, agentComposeVersionId, prompt } = params;

  // Steps 1-2: Load compose version/metadata and verify access
  const { composeContent } = await loadAndAuthorizeCompose(
    userId,
    agentComposeVersionId,
    params.composeId,
  );
  const authorizeTime = Date.now();

  // Step 3: Validate template vars and image access (for new runs only)
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(
      userId,
      composeContent,
      params.vars,
      params.checkEnv,
      params.scopeId,
    );
  }

  // Step 4: Validate mutual exclusivity
  if (params.checkpointId && params.sessionId) {
    throw badRequest(
      "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
    );
  }

  // Resolve scope ID for the run record
  const scopeId = params.scopeId ?? (await getDefaultScope(userId)).scope.id;

  // Step 5: Concurrency check + INSERT in a transaction with advisory lock
  // to prevent TOCTOU race where two concurrent requests both pass the
  // concurrency check before either inserts.
  // On concurrency failure, enqueue the run instead of rejecting.
  let run;
  try {
    run = await globalThis.services.db.transaction(async (tx) => {
      // Acquire per-user advisory lock (released when transaction ends)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

      // Check concurrent run limit within the serialized transaction
      await checkRunConcurrencyLimit(userId, undefined, tx);

      // INSERT within the same transaction
      const [newRun] = await tx
        .insert(agentRuns)
        .values({
          userId,
          scopeId,
          agentComposeVersionId,
          status: "pending",
          prompt,
          vars: params.vars ?? null,
          secretNames: params.secrets ? Object.keys(params.secrets) : null,
          resumedFromCheckpointId: params.resumedFromCheckpointId ?? null,
          continuedFromSessionId: params.sessionId ?? null,
          scheduleId: params.scheduleId ?? null,
          lastHeartbeatAt: new Date(),
        })
        .returning();

      if (!newRun) {
        throw new Error("Failed to create run record");
      }

      return newRun;
    });
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      return enqueueRun({ ...params, scopeId });
    }
    throw error;
  }

  const transactionTime = Date.now();
  log.debug(`Created run ${run.id} for user ${userId}`);

  const result = await buildAndDispatchRun({
    runId: run.id,
    createdAt: run.createdAt,
    params,
    composeContent,
    apiStartTime,
    scopeId,
    authorizeTime,
    transactionTime,
  });

  return {
    runId: run.id,
    status: result.status,
    sandboxId: result.sandboxId,
    createdAt: run.createdAt,
  };
}

/**
 * Execute a previously queued run.
 *
 * Runs the createRun pipeline steps 1-10 for an existing agent_runs record.
 * Re-checks concurrency (another request may have claimed the slot),
 * then skips INSERT (record already exists) and dispatches.
 *
 * Called from drainUserQueue() after dequeuing an entry.
 *
 * @throws ConcurrentRunLimitError if the slot was claimed by another request
 */
export async function executeQueuedRun(
  runId: string,
  params: CreateRunParams,
): Promise<void> {
  const apiStartTime = Date.now();
  const { userId, agentComposeVersionId } = params;

  // Step 1: Re-check concurrency + update status atomically with advisory lock
  // to prevent TOCTOU race where a concurrent createRun claims the slot.
  const [run] = await globalThis.services.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    await checkRunConcurrencyLimit(userId, undefined, tx);

    return tx
      .update(agentRuns)
      .set({
        status: "pending",
        lastHeartbeatAt: new Date(),
      })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued")))
      .returning();
  });
  const transactionTime = Date.now();

  if (!run) {
    throw new Error(`Queued run ${runId} not found or already processed`);
  }

  log.debug(`Executing queued run ${runId} for user ${userId}`);

  // Steps 2-3: Load compose version/metadata and verify access
  const { composeContent } = await loadAndAuthorizeCompose(
    userId,
    agentComposeVersionId,
    params.composeId,
  );
  const authorizeTime = Date.now();

  // Step 4: Validate template vars and image access (for new runs only)
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(
      userId,
      composeContent,
      params.vars,
      params.checkEnv,
      params.scopeId,
    );
  }

  // Steps 5 already validated at enqueue time, skip

  await buildAndDispatchRun({
    runId,
    createdAt: run.createdAt,
    params,
    composeContent,
    apiStartTime,
    scopeId: params.scopeId,
    authorizeTime,
    transactionTime,
  });
}
