import { eq, and, count, gt, or } from "drizzle-orm";
import { env, isSelfHosted } from "../../env";
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
} from "../errors";
import { logger } from "../logger";
import type { ExecutionContext } from "./types";
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
import { canAccessCompose } from "../agent/permission-service";
import { getUserEmail } from "../auth/get-user-email";
import { extractTemplateVars } from "../config-validator";
import { assertImageAccess } from "../image/image-service";
import { getUserScopeByClerkId } from "../scope/scope-service";
import { getVariableValues } from "../variable/variable-service";
import { encryptCredentialValue } from "../crypto/secrets-encryption";

const log = logger("service:run");

// Defense-in-depth: exclude pending runs older than this from concurrency check.
// The cleanup-sandboxes cron job already transitions pending runs to "timeout" after 5 minutes,
// so this TTL only matters if the cron job fails to run.
const PENDING_RUN_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
 * Prepare execution context and dispatch to appropriate executor
 *
 * This is the unified entry point that handles both E2B and runner paths:
 * 1. Prepares the execution context (storage manifest, working dir, etc.)
 * 2. Routes to the appropriate executor based on runner group config
 *
 * @param context ExecutionContext built by buildExecutionContext()
 * @returns ExecutorResult with status and optional sandboxId
 */
async function prepareAndDispatchRun(
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
  } else if (isSelfHosted()) {
    log.debug(`Dispatching run ${context.runId} to Docker executor`);
    return await executeDockerRun(context);
  } else {
    log.debug(`Dispatching run ${context.runId} to E2B executor`);
    return await executeE2bRun(context);
  }
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
  apiStartTime?: number;
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
): Promise<void> {
  if (!composeContent?.agents) {
    return;
  }

  // Only validate vars when checkEnv is enabled (matching expand-environment.ts behavior)
  if (checkEnv) {
    const requiredVars = extractTemplateVars(composeContent);
    if (requiredVars.length > 0) {
      const scope = await getUserScopeByClerkId(userId);
      const storedVars = scope ? await getVariableValues(scope.id) : {};
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

  // Image access validation always runs (not affected by checkEnv)
  const agentKeys = Object.keys(composeContent.agents);
  const firstAgentKey = agentKeys[0];
  const agent = firstAgentKey
    ? composeContent.agents[firstAgentKey]
    : undefined;
  if (agent?.image) {
    await assertImageAccess(userId, agent.image);
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
 * Unified run creation pipeline
 *
 * Validates, creates, and dispatches a run in a single call.
 * All callers (API Route, Public API, Schedule, Slack) should use this.
 *
 * Pipeline:
 * 1. Check concurrent run limit
 * 2. Load compose version content + compose metadata
 * 3. Permission check (canAccessCompose)
 * 4. Validate template vars and image access
 * 5. Validate mutual exclusivity (checkpointId vs sessionId)
 * 6. INSERT agentRuns
 * 7. Register callbacks (if any)
 * 8. Generate sandbox token
 * 9. Build execution context
 * 10. Dispatch to executor
 *
 * @throws ConcurrentRunLimitError - concurrent run limit reached
 * @throws ForbiddenError - user cannot access compose
 * @throws BadRequestError - validation failure (missing vars, mutual exclusivity)
 * @throws NotFoundError - compose version not found
 * @throws Error - dispatch failure (run already marked as "failed")
 */
export async function createRun(
  params: CreateRunParams,
): Promise<CreateRunResult> {
  const { userId, agentComposeVersionId, prompt } = params;

  // Step 1: Check concurrent run limit
  await checkRunConcurrencyLimit(userId);

  // Steps 2-3: Load compose version/metadata and verify access
  const { composeContent } = await loadAndAuthorizeCompose(
    userId,
    agentComposeVersionId,
    params.composeId,
  );

  // Step 4: Validate template vars and image access (for new runs only)
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(
      userId,
      composeContent,
      params.vars,
      params.checkEnv,
    );
  }

  // Step 5: Validate mutual exclusivity
  if (params.checkpointId && params.sessionId) {
    throw badRequest(
      "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
    );
  }

  // Step 6: INSERT agentRuns
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      agentComposeVersionId,
      status: "pending",
      prompt,
      vars: params.vars ?? null,
      secretNames: params.secrets ? Object.keys(params.secrets) : null,
      resumedFromCheckpointId: params.resumedFromCheckpointId ?? null,
      scheduleId: params.scheduleId ?? null,
      lastHeartbeatAt: new Date(),
    })
    .returning();

  if (!run) {
    throw new Error("Failed to create run record");
  }

  log.debug(`Created run ${run.id} for user ${userId}`);

  // From this point on, errors must mark the run as "failed"
  try {
    // Step 7: Register callbacks (if any)
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(run.id, params.callbacks);
    }

    // Step 8: Generate sandbox token
    const sandboxToken = await generateSandboxToken(userId, run.id);

    // Step 9: Build execution context (pass pre-loaded compose to avoid double fetch)
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
      runId: run.id,
      sandboxToken,
      userId,
      agentName: params.agentName,
      resumedFromCheckpointId: params.resumedFromCheckpointId,
      continuedFromSessionId: params.sessionId,
      debugNoMockClaude: params.debugNoMockClaude,
      modelProvider: params.modelProvider,
      checkEnv: params.checkEnv,
      apiStartTime: params.apiStartTime,
    });

    // Step 10: Dispatch to executor
    const result = await prepareAndDispatchRun(context);

    log.debug(`Run ${run.id} dispatched with status: ${result.status}`);

    return {
      runId: run.id,
      status: result.status,
      sandboxId: result.sandboxId,
      createdAt: run.createdAt,
    };
  } catch (error) {
    await markRunFailed(run.id, run.createdAt, error);
    throw error;
  }
}
