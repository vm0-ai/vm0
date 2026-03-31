import { eq, and, count, gt, or, sql } from "drizzle-orm";
import { env } from "../../env";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import { transitionRunStatus, dispatchTerminalSideEffects } from "./run-status";
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
import { enqueueRun, drainOrgQueue } from "./run-queue-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { logger } from "../logger";
import type { Database } from "../../types/global";
import type { AgentComposeSnapshot } from "../checkpoint/types";
import type { AgentComposeYaml } from "../../types/agent-compose";
import { getAgentSessionWithConversation } from "../agent-session";
import { prepareForExecution } from "./context/execution-preparer";
import { executeRunnerJob } from "./executors/runner-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import { generateSandboxToken } from "../auth/sandbox-token";
import type { ExecutionContext, RuntimeOrg } from "./types";
import { buildZeroExecutionContext } from "../zero/build-zero-context";
import { recordSandboxOperation } from "../metrics";
import { extractTemplateVars } from "../config-validator";
import { canAccessCompose } from "../agent/compose-access";

import { getVariableValues } from "../variable/variable-service";
import { encryptSecretValue } from "../crypto/secrets-encryption";
import {
  type OrgTier,
  type RunStatus,
  type GetRunResponse,
  type FirewallPolicies,
  type ConnectorType,
  orgTierSchema,
} from "@vm0/core";
import { getOrgData } from "../org/org-cache-service";
import { agentRunQueue } from "../../db/schema/agent-run-queue";
import { publishCancelNotification } from "../realtime/client";
import { processOrgCredits } from "../credit/credit-service";

const log = logger("service:run");

// Defense-in-depth: exclude pending runs older than this from concurrency check.
// The cleanup-sandboxes cron job already transitions pending runs to "timeout" after 5 minutes,
// so this TTL only matters if the cron job fails to run.
export const PENDING_RUN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Concurrent run limits by org tier */
const TIER_CONCURRENCY_LIMITS: Record<OrgTier, number> = {
  free: 1,
  pro: 2,
  team: 5,
};

function getConcurrencyLimitForTier(tier: OrgTier): number {
  return TIER_CONCURRENCY_LIMITS[tier];
}

/**
 * Get the effective concurrency limit for an org tier.
 * Tier-based limit is the baseline; env var acts as a global cap.
 * Returns 0 for unlimited.
 */
export function getEffectiveConcurrencyLimit(orgTier: OrgTier): number {
  const tierLimit = getConcurrencyLimitForTier(orgTier);
  const envCap = env().CONCURRENT_RUN_LIMIT_CAP;
  if (envCap === 0) return 0;
  if (envCap !== undefined && !isNaN(envCap))
    return Math.min(tierLimit, envCap);
  return tierLimit;
}

/**
 * Check if org has reached concurrent run limit
 *
 * @param orgId Clerk org ID to check
 * @param orgTier Org tier for tier-based limit (default: "free")
 * @param db Optional database instance (for use within transactions)
 * @throws ConcurrentRunLimitError if limit exceeded
 */
export async function checkRunConcurrencyLimit(
  orgId: string,
  orgTier: OrgTier = "free",
  db?: Database,
): Promise<void> {
  const effectiveLimit = getEffectiveConcurrencyLimit(orgTier);

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
        eq(agentRuns.orgId, orgId),
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
      `Org ${orgId} has ${activeRunCount} active runs, limit is ${effectiveLimit}`,
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
async function validateCheckpoint(
  checkpointId: string,
  userId: string,
): Promise<{
  agentComposeVersionId: string;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
}> {
  log.debug(`Validating checkpoint ${checkpointId} for user ${userId}`);

  // Load checkpoint with associated run in a single query
  const [result] = await globalThis.services.db
    .select({
      agentComposeSnapshot: checkpoints.agentComposeSnapshot,
      runUserId: agentRuns.userId,
      runVars: agentRuns.vars,
      runSecretNames: agentRuns.secretNames,
    })
    .from(checkpoints)
    .leftJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
    .where(eq(checkpoints.id, checkpointId))
    .limit(1);

  if (!result) {
    throw notFound("Checkpoint not found");
  }

  // Verify the associated run exists and belongs to user
  if (!result.runUserId) {
    throw notFound("Associated run not found");
  }

  if (result.runUserId !== userId) {
    throw unauthorized("Checkpoint does not belong to authenticated user");
  }

  // Get version ID from snapshot
  const agentComposeSnapshot =
    result.agentComposeSnapshot as unknown as AgentComposeSnapshot;

  const agentComposeVersionId = agentComposeSnapshot.agentComposeVersionId;
  if (!agentComposeVersionId) {
    throw badRequest("Invalid checkpoint: missing agentComposeVersionId");
  }

  log.debug(
    `Checkpoint validated: agentComposeVersionId=${agentComposeVersionId}`,
  );

  // Get vars from original run, secretNames from run (values are NEVER stored)
  const vars = (result.runVars as Record<string, string>) ?? null;
  const secretNames = (result.runSecretNames as string[]) ?? null;

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
 * - Runner Group: explicit runner config in compose or RUNNER_DEFAULT_GROUP
 *
 */
async function dispatchRun(context: PreparedContext): Promise<ExecutorResult> {
  if (context.runnerGroup) {
    log.debug(
      `Dispatching run ${context.runId} to runner group: ${context.runnerGroup}`,
    );
    return await executeRunnerJob(context);
  }

  // Route to runner when RUNNER_DEFAULT_GROUP is configured.
  const defaultGroup = env().RUNNER_DEFAULT_GROUP;
  if (defaultGroup) {
    log.debug(
      `Dispatching run ${context.runId} to runner (default group: ${defaultGroup})`,
    );
    return await executeRunnerJob({ ...context, runnerGroup: defaultGroup });
  }

  throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
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

export function isRunDispatchError(error: unknown): error is RunDispatchError {
  return error instanceof Error && "runId" in error;
}

export interface CreateRunParams {
  // Required — every caller must provide
  userId: string;
  agentComposeVersionId: string;
  prompt: string;
  appendSystemPrompt?: string;
  disallowedTools?: string[];
  tools?: string[];
  settings?: string;

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
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  resumedFromCheckpointId?: string;
  agentName?: string;
  modelProvider?: string;
  debugNoMockClaude?: boolean;
  checkEnv?: boolean;
  // Caller-resolved org context for variable/storage resolution.
  orgId: string;
  // Caller-resolved org tier for concurrency limit derivation.
  orgTier?: OrgTier;
  // Per-permission firewall policies from zero agent configuration.
  firewallPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];
}

/**
 * High-level run params — callers provide a compose identifier and startRun()
 * resolves version + org internally.
 *
 * Compose resolution modes (mutually exclusive):
 * - composeId: new run from compose (resolves headVersionId)
 * - agentComposeVersionId: new run from pinned version (SDK/CLI)
 * - checkpointId: resume from checkpoint (resolves version from checkpoint)
 * - sessionId: continue session (resolves version from session's compose)
 */
interface StartRunParams {
  userId: string;
  prompt: string;

  // --- Compose resolution (mutually exclusive) ---
  composeId?: string;
  agentComposeVersionId?: string;
  checkpointId?: string;
  sessionId?: string;

  // --- Caller-validated org (optional, for API routes with org membership) ---
  // When provided, startRun() verifies the compose belongs to this org
  // and uses it for authorization. When omitted, org is auto-resolved
  // from the compose (used by integration callers that verify access upstream).
  callerOrgId?: string;

  // --- Optional params (forwarded to createRun) ---
  appendSystemPrompt?: string;
  disallowedTools?: string[];
  tools?: string[];
  settings?: string;
  conversationId?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  modelProvider?: string;
  debugNoMockClaude?: boolean;
  checkEnv?: boolean;
  firewallPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];
}

export interface CreateRunResult {
  runId: string;
  status: RunStatus;
  sandboxId?: string;
  createdAt: Date;
}

/**
 * Load compose version and compose metadata.
 *
 * @returns composeContent and compose record
 * @throws NotFoundError - version or compose not found
 */
export async function loadCompose(
  agentComposeVersionId: string,
  callerComposeId?: string,
): Promise<{
  composeContent: AgentComposeYaml;
  compose: { id: string; userId: string; orgId: string };
}> {
  if (callerComposeId) {
    // When caller provides composeId, both queries are independent — run in parallel
    const [versionResult, composeResult] = await Promise.all([
      globalThis.services.db
        .select({ content: agentComposeVersions.content })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, agentComposeVersionId))
        .limit(1),
      globalThis.services.db
        .select({
          id: agentComposes.id,
          userId: agentComposes.userId,
          orgId: agentComposes.orgId,
        })
        .from(agentComposes)
        .where(eq(agentComposes.id, callerComposeId))
        .limit(1),
    ]);

    if (!versionResult[0]) {
      throw notFound("Agent compose version not found");
    }
    if (!composeResult[0]) {
      throw notFound("Agent compose not found");
    }

    return {
      composeContent: versionResult[0].content as AgentComposeYaml,
      compose: composeResult[0],
    };
  }

  // No caller composeId — fetch version with compose via LEFT JOIN
  // Use LEFT JOIN so we can distinguish "version missing" from "compose missing"
  const [result] = await globalThis.services.db
    .select({
      content: agentComposeVersions.content,
      composeId: agentComposes.id,
      composeUserId: agentComposes.userId,
      agentClerkOrgId: agentComposes.orgId,
    })
    .from(agentComposeVersions)
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!result) {
    throw notFound("Agent compose version not found");
  }

  if (!result.composeId || !result.composeUserId || !result.agentClerkOrgId) {
    throw notFound("Agent compose not found");
  }

  return {
    composeContent: result.content as AgentComposeYaml,
    compose: {
      id: result.composeId,
      userId: result.composeUserId,
      orgId: result.agentClerkOrgId,
    },
  };
}

export function authorizeCompose(
  userId: string,
  orgId: string,
  compose: { id: string; userId: string; orgId: string },
): void {
  const hasAccess = canAccessCompose(userId, orgId, compose);
  if (!hasAccess) {
    throw forbidden("You do not have permission to access this agent");
  }
}

/**
 * Validate template vars availability and image access for new runs.
 *
 * Skipped when resuming from checkpoint or continuing a session.
 * Vars validation only runs when checkEnv is enabled (matching expand-environment.ts behavior).
 *
 * @throws BadRequestError - missing required template variables (only when checkEnv is true)
 */
export async function validateComposeRequirements(
  userId: string,
  composeContent: AgentComposeYaml,
  orgId: string,
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
      const [orgVars, userVars] = await Promise.all([
        getVariableValues(orgId, ORG_SENTINEL_USER_ID),
        getVariableValues(orgId, userId),
      ]);
      const allVars = { ...orgVars, ...userVars, ...vars };
      const missingVars = requiredVars.filter((varName) => {
        return allVars[varName] === undefined;
      });
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
export async function registerCallbacks(
  runId: string,
  callbacks: Array<{ url: string; secret: string; payload: unknown }>,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  await globalThis.services.db.insert(agentRunCallbacks).values(
    callbacks.map((callback) => {
      return {
        runId,
        url: callback.url,
        encryptedSecret: encryptSecretValue(
          callback.secret,
          SECRETS_ENCRYPTION_KEY,
        ),
        payload: callback.payload,
      };
    }),
  );
  log.debug(`Registered ${callbacks.length} callback(s) for run ${runId}`);
}

/**
 * Mark a run as failed, dispatch terminal side effects, and attach run
 * metadata to the error for callers.
 *
 * @param drain - Optional queue drain function. Injected by callers to release
 *   concurrency slots when a run that occupied one fails during dispatch.
 */
export async function markRunFailed(
  runId: string,
  createdAt: Date,
  error: unknown,
  drain?: () => Promise<void>,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  log.error(`Run ${runId} failed: ${errorMessage}`);

  const transitioned = await transitionRunStatus(
    runId,
    {
      status: "failed",
      error: errorMessage,
      completedAt: new Date(),
    },
    ["queued", "pending", "running"],
  );

  // Dispatch callbacks (e.g., loop schedule advancement) and drain queue if transition succeeded
  if (transitioned) {
    await dispatchTerminalSideEffects(runId, "failed", errorMessage, drain);
  }

  // Attach run metadata so callers can return partial results
  if (error instanceof Error) {
    (error as RunDispatchError).runId = runId;
    (error as RunDispatchError).createdAt = createdAt;
  }
}

/**
 * Shared dispatch pipeline for steps 6-10 of the run creation flow.
 * Used by both createRun (new runs) and dispatchQueuedRun (dequeued runs).
 */
export async function buildAndDispatchRun(opts: {
  runId: string;
  createdAt: Date;
  params: CreateRunParams;
  // Pre-built execution context (caller resolves all secrets/providers/firewalls)
  context: ExecutionContext;
  runtimeOrg: RuntimeOrg;
  resolvedModelProvider?: string;
  selectedModel?: string;
  buildContextTimings: { resolveSourceAndOrg: number; resolveSecrets: number };
  // Timing anchors
  apiStartTime: number;
  orgId: string;
  authorizeTime: number;
  transactionTime: number;
  tokenTime: number;
  queueDispatcher?: (
    runId: string,
    createdAt: Date,
    params: CreateRunParams,
  ) => Promise<void>;
}): Promise<{ status: RunStatus; sandboxId?: string }> {
  const {
    runId,
    createdAt,
    params,
    context,
    runtimeOrg,
    resolvedModelProvider,
    selectedModel,
    buildContextTimings,
    apiStartTime,
    orgId,
    authorizeTime,
    transactionTime,
    tokenTime,
  } = opts;

  try {
    // Register callbacks (sandbox token already generated by caller)
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(runId, params.callbacks);
    }

    const buildContextTime = Date.now();

    // Refresh heartbeat after the heaviest pipeline step to prevent the
    // cleanup cron from timing out runs whose dispatch takes > 5 minutes.
    // Status guard avoids touching runs cancelled/failed while in-flight.
    // Also persist the resolved model provider type (when the user selected
    // "Default", the INSERT stored null — this UPDATE writes the actual value).
    await globalThis.services.db
      .update(agentRuns)
      .set({
        lastHeartbeatAt: new Date(),
        ...(resolvedModelProvider
          ? { modelProvider: resolvedModelProvider }
          : {}),
        ...(selectedModel ? { selectedModel } : {}),
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          or(eq(agentRuns.status, "pending"), eq(agentRuns.status, "running")),
        ),
      );

    // Prepare execution context (storage manifest, working dir, etc.)
    const prepareResult = await prepareForExecution(context, runtimeOrg);
    const prepareTime = Date.now();

    // Dispatch to executor
    const result = await dispatchRun(prepareResult.context);
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
      // Sub-step timings within buildExecutionContext
      {
        op: "api_build_resolve_source_and_org",
        ms: buildContextTimings.resolveSourceAndOrg,
      },
      {
        op: "api_build_resolve_secrets",
        ms: buildContextTimings.resolveSecrets,
      },
      // Sub-step timings within prepareForExecution
      {
        op: "api_prepare_resolve_orgs",
        ms: prepareResult.timings.resolveOrgs,
      },
      {
        op: "api_prepare_ensure_storage",
        ms: prepareResult.timings.ensureStorage,
      },
      {
        op: "api_prepare_storage_manifest",
        ms: prepareResult.timings.storageManifest,
      },
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
    const dispatcher = opts.queueDispatcher ?? dispatchQueuedRun;
    await markRunFailed(
      runId,
      createdAt,
      error,
      orgId
        ? () => {
            return drainOrgQueue(orgId, dispatcher);
          }
        : undefined,
    );
    throw error;
  }
}

/**
 * Resolved compose metadata from one of the 4 resolution modes.
 */
interface ResolvedStartRunCompose {
  agentComposeVersionId: string;
  composeId?: string;
  agentName?: string;
  orgId: string;
}

/**
 * Look up compose metadata from a version ID (shared by checkpoint + versionId paths).
 */
async function lookupComposeByVersion(
  versionId: string,
  fallbackComposeId?: string,
): Promise<{ composeId?: string; agentName?: string; orgId: string }> {
  const [row] = await globalThis.services.db
    .select({
      composeName: agentComposes.name,
      composeOrgId: agentComposes.orgId,
      composeId: agentComposes.id,
    })
    .from(agentComposeVersions)
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  return {
    composeId: row?.composeId ?? fallbackComposeId,
    agentName: row?.composeName ?? undefined,
    orgId: row?.composeOrgId ?? "",
  };
}

/**
 * Resolve compose by composeId → headVersionId.
 */
async function resolveByComposeId(
  composeId: string,
): Promise<ResolvedStartRunCompose> {
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    throw notFound("Agent compose not found");
  }
  if (!compose.headVersionId) {
    throw badRequest("Agent compose has no versions. Run 'vm0 build' first.");
  }

  return {
    agentComposeVersionId: compose.headVersionId,
    composeId: compose.id,
    agentName: compose.name ?? undefined,
    orgId: compose.orgId,
  };
}

/**
 * Resolve compose version + org ID from StartRunParams.
 *
 * Handles 4 mutually exclusive resolution modes:
 * 1. checkpointId → validate checkpoint → get version, then look up compose
 * 2. sessionId → validate session → get compose → use headVersionId
 * 3. agentComposeVersionId → use directly, look up compose metadata
 * 4. composeId → load compose → use headVersionId
 */
export async function resolveStartRunCompose(
  params: StartRunParams,
): Promise<ResolvedStartRunCompose> {
  // Validate mutual exclusivity before resolution
  if (params.checkpointId && params.sessionId) {
    throw badRequest(
      "Cannot specify both checkpointId and sessionId. Use one or the other.",
    );
  }

  if (params.checkpointId) {
    const checkpointData = await validateCheckpoint(
      params.checkpointId,
      params.userId,
    );
    const meta = await lookupComposeByVersion(
      checkpointData.agentComposeVersionId,
    );
    if (!meta.orgId) {
      throw notFound("Agent compose version not found");
    }
    return {
      agentComposeVersionId: checkpointData.agentComposeVersionId,
      ...meta,
    };
  }

  if (params.sessionId) {
    const sessionData = await validateAgentSession(
      params.sessionId,
      params.userId,
    );
    return resolveByComposeId(sessionData.agentComposeId);
  }

  if (params.agentComposeVersionId) {
    const meta = await lookupComposeByVersion(
      params.agentComposeVersionId,
      params.composeId,
    );
    if (!meta.orgId) {
      throw notFound("Agent compose version not found");
    }
    return { agentComposeVersionId: params.agentComposeVersionId, ...meta };
  }

  if (!params.composeId) {
    throw badRequest(
      "Missing agentComposeId or agentComposeVersionId. Provide composeId, agentComposeVersionId, checkpointId, or sessionId.",
    );
  }

  return resolveByComposeId(params.composeId);
}

/**
 * High-level run entry point — the single public API for all run creation.
 *
 * Resolves compose version + org context internally, then delegates to
 * createRun(). Callers only need a compose identifier (composeId, versionId,
 * checkpointId, or sessionId) — no manual DB queries or org resolution.
 *
 * @throws NotFoundError - compose/version/checkpoint/session not found
 * @throws BadRequestError - compose has no versions, or missing identifier
 * @throws ForbiddenError - user cannot access compose
 * @throws Error - dispatch failure
 */
export async function startRun(
  params: StartRunParams,
): Promise<CreateRunResult> {
  // 1. Resolve compose version
  const resolved = await resolveStartRunCompose(params);

  // 2. Cross-org check: if caller provides a validated orgId, ensure
  //    the compose belongs to that org. This prevents users from accessing
  //    composes in orgs they don't belong to (used by API routes).
  if (params.callerOrgId && resolved.orgId !== params.callerOrgId) {
    throw notFound("Resource not found");
  }

  // 3. Resolve org context (use callerOrgId for authorization when available)
  const authOrgId = params.callerOrgId ?? resolved.orgId;
  const orgData = await getOrgData(authOrgId);
  const orgTier = orgTierSchema.parse(orgData.tier);

  // 4. Delegate to createRun with fully resolved params
  return createRun({
    userId: params.userId,
    agentComposeVersionId: resolved.agentComposeVersionId,
    prompt: params.prompt,
    appendSystemPrompt: params.appendSystemPrompt,
    disallowedTools: params.disallowedTools,
    tools: params.tools,
    settings: params.settings,
    composeId: resolved.composeId,
    checkpointId: params.checkpointId,
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    vars: params.vars,
    secrets: params.secrets,
    artifactName: params.artifactName,
    artifactVersion: params.artifactVersion,
    memoryName: params.memoryName,
    volumeVersions: params.volumeVersions,
    callbacks: params.callbacks,
    resumedFromCheckpointId: params.checkpointId,
    agentName: resolved.agentName,
    modelProvider: params.modelProvider,
    debugNoMockClaude: params.debugNoMockClaude,
    checkEnv: params.checkEnv,
    firewallPolicies: params.firewallPolicies,
    allowedConnectorTypes: params.allowedConnectorTypes,
    orgId: authOrgId,
    orgTier,
  });
}

/**
 * Result of createRunRecord — contains the run record and all metadata
 * needed by buildAndDispatchRun to complete the dispatch pipeline.
 */
interface CreateRunRecordResult {
  run: { id: string; createdAt: Date };
  composeContent: AgentComposeYaml;
  orgId: string;
  apiStartTime: number;
  authorizeTime: number;
  transactionTime: number;
}

/**
 * Create a run record without dispatching.
 *
 * Handles steps 1-5 of the run creation pipeline:
 * 1. Load compose version content + compose metadata
 * 2. Permission check (canAccessCompose)
 * 3. Validate template vars and image access
 * 4. Validate mutual exclusivity (checkpointId vs sessionId)
 * 5. Acquire per-org advisory lock, check concurrent run limit, INSERT agentRuns (atomic transaction)
 *
 * Returns the run record and compose content needed by buildAndDispatchRun().
 * Does NOT handle the enqueueRun() fallback — callers decide how to handle
 * ConcurrentRunLimitError.
 *
 * @throws ForbiddenError - user cannot access compose
 * @throws BadRequestError - validation failure (missing vars, mutual exclusivity)
 * @throws NotFoundError - compose version not found
 * @throws ConcurrentRunLimitError - org has reached concurrent run limit
 */
export async function createRunRecord(
  params: CreateRunParams,
): Promise<CreateRunRecordResult> {
  const apiStartTime = Date.now();
  const { userId, agentComposeVersionId, prompt } = params;

  // Steps 1-2: Load compose and authorize
  const { composeContent, compose } = await loadCompose(
    agentComposeVersionId,
    params.composeId,
  );
  authorizeCompose(userId, params.orgId, compose);
  const authorizeTime = Date.now();

  // Step 3: Validate template vars and image access (for new runs only)
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(
      userId,
      composeContent,
      params.orgId,
      params.vars,
      params.checkEnv,
    );
  }

  // Step 4: Validate mutual exclusivity
  if (params.checkpointId && params.sessionId) {
    throw badRequest(
      "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
    );
  }

  // Org context for the run record and storage (required from caller)
  const orgId = params.orgId;

  // Step 5: Concurrency check + INSERT in a transaction with advisory lock
  // to prevent TOCTOU race where two concurrent requests both pass the
  // concurrency check before either inserts.
  const run = await globalThis.services.db.transaction(async (tx) => {
    // Acquire per-org advisory lock (released when transaction ends)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);

    // Check concurrent run limit within the serialized transaction
    await checkRunConcurrencyLimit(orgId, params.orgTier ?? "free", tx);

    // INSERT within the same transaction
    const [newRun] = await tx
      .insert(agentRuns)
      .values({
        userId,
        orgId,
        agentComposeVersionId,
        status: "pending",
        prompt,
        appendSystemPrompt: params.appendSystemPrompt ?? null,
        vars: params.vars ?? null,
        secretNames: params.secrets ? Object.keys(params.secrets) : null,
        resumedFromCheckpointId: params.resumedFromCheckpointId ?? null,
        continuedFromSessionId: params.sessionId ?? null,
        modelProvider: params.modelProvider ?? null,
        lastHeartbeatAt: new Date(),
      })
      .returning();

    if (!newRun) {
      throw new Error("Failed to create run record");
    }

    return newRun;
  });

  const transactionTime = Date.now();
  log.debug(`Created run ${run.id} for user ${userId}`);

  return {
    run: { id: run.id, createdAt: run.createdAt },
    composeContent,
    orgId,
    apiStartTime,
    authorizeTime,
    transactionTime,
  };
}

/**
 * Low-level run creation pipeline (requires pre-resolved version + org).
 *
 * Composes createRunRecord() + buildAndDispatchRun() into a single call.
 * Handles the enqueueRun() fallback when the org hits the concurrent run limit.
 * Prefer startRun() unless you need checkpoint/session resume or custom params.
 *
 * @throws ForbiddenError - user cannot access compose
 * @throws BadRequestError - validation failure (missing vars, mutual exclusivity)
 * @throws NotFoundError - compose version not found
 * @throws Error - dispatch failure (run already marked as "failed")
 */
export async function createRun(
  params: CreateRunParams,
): Promise<CreateRunResult> {
  let record: CreateRunRecordResult;
  try {
    record = await createRunRecord(params);
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      return enqueueRun(params);
    }
    throw error;
  }

  const sandboxToken = await generateSandboxToken(params.userId, record.run.id);
  const tokenTime = Date.now();

  try {
    // Register callbacks early so they persist even if context building fails
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(record.run.id, params.callbacks);
    }

    const contextResult = await buildZeroExecutionContext({
      ...params,
      sandboxToken,
      runId: record.run.id,
      agentCompose: record.composeContent,
      continuedFromSessionId: params.sessionId,
    });

    const result = await buildAndDispatchRun({
      runId: record.run.id,
      createdAt: record.run.createdAt,
      params: { ...params, callbacks: undefined },
      context: contextResult.context,
      runtimeOrg: contextResult.runtimeOrg,
      resolvedModelProvider: contextResult.resolvedModelProvider,
      selectedModel: contextResult.selectedModel,
      buildContextTimings: contextResult.timings,
      apiStartTime: record.apiStartTime,
      orgId: record.orgId,
      authorizeTime: record.authorizeTime,
      transactionTime: record.transactionTime,
      tokenTime,
    });

    return {
      runId: record.run.id,
      status: result.status,
      sandboxId: result.sandboxId,
      createdAt: record.run.createdAt,
    };
  } catch (error) {
    // Mark run as failed when context building or dispatch fails.
    // buildAndDispatchRun may have already called markRunFailed — the
    // second call is a safe no-op (transitionRunStatus guards on status).
    await markRunFailed(record.run.id, record.run.createdAt, error, () => {
      return drainOrgQueue(record.orgId, dispatchQueuedRun);
    });
    throw error;
  }
}

/**
 * Dispatch a previously queued run that has already been dequeued and
 * transitioned to "pending" by drainOrgQueue().
 *
 * Loads compose content, authorizes, and dispatches. Does NOT acquire
 * advisory lock or check concurrency — that is handled atomically in
 * the drain transaction.
 *
 * Called from drainOrgQueue() after the atomic dequeue + status update.
 */
export async function dispatchQueuedRun(
  runId: string,
  createdAt: Date,
  params: CreateRunParams,
  queueDispatcher?: (
    runId: string,
    createdAt: Date,
    params: CreateRunParams,
  ) => Promise<void>,
): Promise<void> {
  const apiStartTime = Date.now();
  const { userId, agentComposeVersionId } = params;
  const transactionTime = apiStartTime; // No separate transaction step

  log.debug(`Dispatching queued run ${runId} for user ${userId}`);

  // Load compose and authorize
  const { composeContent, compose: queuedCompose } = await loadCompose(
    agentComposeVersionId,
    params.composeId,
  );
  authorizeCompose(userId, params.orgId, queuedCompose);
  const authorizeTime = Date.now();

  // Validate template vars and image access (for new runs only)
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(
      userId,
      composeContent,
      params.orgId,
      params.vars,
      params.checkEnv,
    );
  }

  const sandboxToken = await generateSandboxToken(params.userId, runId);
  const tokenTime = Date.now();

  try {
    // Register callbacks early so they persist even if context building fails
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(runId, params.callbacks);
    }

    const contextResult = await buildZeroExecutionContext({
      ...params,
      sandboxToken,
      runId,
      agentCompose: composeContent,
      continuedFromSessionId: params.sessionId,
    });

    await buildAndDispatchRun({
      runId,
      createdAt,
      params: { ...params, callbacks: undefined },
      context: contextResult.context,
      runtimeOrg: contextResult.runtimeOrg,
      resolvedModelProvider: contextResult.resolvedModelProvider,
      selectedModel: contextResult.selectedModel,
      buildContextTimings: contextResult.timings,
      apiStartTime,
      orgId: params.orgId,
      authorizeTime,
      transactionTime,
      tokenTime,
      queueDispatcher,
    });
  } catch (error) {
    const dispatcher = queueDispatcher ?? dispatchQueuedRun;
    await markRunFailed(runId, createdAt, error, () => {
      return drainOrgQueue(params.orgId, dispatcher);
    });
    throw error;
  }
}

/**
 * Get a run by ID, scoped to user and org for security.
 * Returns the run response object or null if not found.
 */
export async function getRunById(
  runId: string,
  userId: string,
  orgId: string,
): Promise<GetRunResponse | null> {
  const [run] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    )
    .limit(1);

  if (!run) return null;

  return {
    runId: run.id,
    agentComposeVersionId: run.agentComposeVersionId,
    status: run.status as RunStatus,
    prompt: run.prompt,
    appendSystemPrompt: run.appendSystemPrompt,
    vars: run.vars as Record<string, string> | undefined,
    sandboxId: run.sandboxId || undefined,
    result: run.result as Record<string, unknown> | undefined,
    error: run.error || undefined,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
  };
}

/**
 * Result of a successful run cancellation, used to dispatch side effects.
 */
interface CancelRunResult {
  runId: string;
  previousStatus: string;
  orgId: string;
  sandboxId: string | null;
  runnerGroup: string | null;
}

/**
 * Cancel a run. Atomically deletes queue entry and transitions status.
 * Throws NotFound if run doesn't exist, BadRequest if run can't be cancelled.
 */
export async function cancelRun(
  runId: string,
  userId: string,
  orgId: string,
): Promise<CancelRunResult> {
  const db = globalThis.services.db;

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    )
    .limit(1);

  if (!run) {
    throw notFound(`No such run: '${runId}'`);
  }

  if (
    run.status !== "queued" &&
    run.status !== "pending" &&
    run.status !== "running"
  ) {
    throw badRequest(
      `Run cannot be cancelled: current status is '${run.status}'`,
    );
  }

  const cancelled = await db.transaction(async (tx) => {
    await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, runId));
    return transitionRunStatus(
      runId,
      { status: "cancelled", completedAt: new Date() },
      ["queued", "pending", "running"],
      tx,
    );
  });

  if (!cancelled) {
    throw badRequest(`Run cannot be cancelled: status has already changed`);
  }

  return {
    runId,
    previousStatus: run.status,
    orgId: run.orgId,
    sandboxId: run.sandboxId,
    runnerGroup: run.runnerGroup,
  };
}

/**
 * Dispatch post-cancellation side effects (Ably notification, callbacks, queue drain, credits).
 * Designed to be called inside `after()` so it runs after the response is sent.
 */
export async function dispatchCancelSideEffects(
  result: CancelRunResult,
  queueDispatcher: (
    runId: string,
    createdAt: Date,
    params: CreateRunParams,
  ) => Promise<void> = dispatchQueuedRun,
): Promise<void> {
  const log = logger("service:run:cancel");

  if (result.previousStatus === "running" && result.runnerGroup) {
    const published = await publishCancelNotification(
      result.runnerGroup,
      result.runId,
    );
    if (!published) {
      log.warn(
        `Ably cancel notification failed for run ${result.runId}, VM will run until natural completion`,
      );
    }
  }

  const shouldDrain =
    result.previousStatus === "running" || result.previousStatus === "pending";

  await dispatchTerminalSideEffects(
    result.runId,
    "cancelled",
    "Run cancelled",
    shouldDrain
      ? () => {
          return drainOrgQueue(result.orgId, queueDispatcher);
        }
      : undefined,
  );

  if (shouldDrain) {
    await processOrgCredits(result.orgId);
  }
}
