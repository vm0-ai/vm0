import { eq, and, count, gt, or, sql } from "drizzle-orm";
import { env } from "../../../env";
import { checkpoints } from "../../../db/schema/checkpoint";
import { agentRuns } from "../../../db/schema/agent-run";
import { transitionRunStatus, dispatchTerminalSideEffects } from "./run-status";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../db/schema/agent-compose";
import { agentRunCallbacks } from "../../../db/schema/agent-run-callback";
import {
  notFound,
  unauthorized,
  badRequest,
  forbidden,
  concurrentRunLimit,
} from "../../shared/errors";

import { logger } from "../../shared/logger";
import type { Database } from "../../../types/global";
import type { AgentComposeSnapshot } from "../checkpoint/types";
import type { AgentComposeYaml } from "../agent-compose/types";
import { getAgentSessionWithConversation } from "../agent-session";
import { prepareForExecution } from "./context/execution-preparer";
import { executeRunnerJob } from "./executors/runner-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import { generateSandboxToken } from "../../auth/sandbox-token";
import type { ExecutionContext, DispatchTimings, ResumeSession } from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import { buildInfraExecutionContext } from "./context/build-context";
import { recordSandboxOperation } from "../metrics";
import { canAccessCompose } from "../agent/compose-access";

import { encryptSecretValue } from "../../shared/crypto/secrets-encryption";
import {
  type OrgTier,
  type RunStatus,
  type GetRunResponse,
  type Firewalls,
  type FirewallPolicies,
  type ConnectorType,
} from "@vm0/core";
import { publishCancelNotification } from "../realtime/client";
import type { CancelRunResult } from "../../zero/zero-run-cancel";

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
 * the error is augmented with runId so callers can return partial
 * results if needed.
 */
export interface RunDispatchError extends Error {
  runId?: string;
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
  // Caller-resolved org context for variable/storage resolution.
  orgId: string;
  // Caller-resolved org tier for concurrency limit derivation.
  orgTier?: OrgTier;
  // Per-permission firewall policies from zero agent configuration.
  firewallPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];
  // Pre-loaded compose data. When provided, skips the internal loadCompose() call.
  preloadedCompose?: {
    composeContent: AgentComposeYaml;
    compose: { id: string; userId: string; orgId: string };
  };
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
export interface StartRunParams {
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
  debugNoMockClaude?: boolean;
  firewallPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];

  // --- Pre-resolved context data (from resolveCliRunContext or caller) ---
  environment?: Record<string, string>;
  secretConnectorMap?: Record<string, string>;
  userTimezone?: string;
  firewalls?: Firewalls;
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;

  // --- Pre-resolved org tier (callers resolve via getOrgData + orgTierSchema) ---
  orgTier: OrgTier;

  // --- Pre-resolved timing data (passed through to dispatch timings) ---
  resolveSourceDuration?: number;
  resolveSecretsDuration?: number;
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
 * Validate image access for new runs.
 *
 * Skipped when resuming from checkpoint or continuing a session.
 */
export async function validateComposeRequirements(
  composeContent: AgentComposeYaml,
): Promise<void> {
  if (!composeContent?.agents) {
    return;
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
 * Mark a run as failed, dispatch terminal side effects (callbacks), and
 * attach run metadata to the error for callers.
 *
 * Queue draining is NOT done here — callers are responsible for calling
 * drainOrgQueue() separately after this function returns.
 */
export async function markRunFailed(
  runId: string,
  error: unknown,
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

  // Dispatch callbacks (e.g., loop schedule advancement) if transition succeeded
  if (transitioned) {
    await dispatchTerminalSideEffects(runId, "failed", errorMessage);
  }

  // Attach run metadata so callers can return partial results
  if (error instanceof Error) {
    (error as RunDispatchError).runId = runId;
  }
}

/**
 * Shared dispatch pipeline for steps 6-10 of the run creation flow.
 * Used by startRun (new runs) and dispatchQueuedZeroRun (dequeued runs).
 */
export async function buildAndDispatchRun(opts: {
  runId: string;
  // Pre-built execution context (caller resolves all secrets/providers/firewalls)
  context: ExecutionContext;
  timings: DispatchTimings;
}): Promise<{ status: RunStatus; sandboxId?: string }> {
  const { runId, context, timings } = opts;

  try {
    const buildContextTime = Date.now();

    // Refresh heartbeat after the heaviest pipeline step to prevent the
    // cleanup cron from timing out runs whose dispatch takes > 5 minutes.
    // Status guard avoids touching runs cancelled/failed while in-flight.
    await globalThis.services.db
      .update(agentRuns)
      .set({
        lastHeartbeatAt: new Date(),
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          or(eq(agentRuns.status, "pending"), eq(agentRuns.status, "running")),
        ),
      );

    // Prepare execution context (storage manifest, working dir, etc.)
    const prepareResult = await prepareForExecution(context);
    const prepareTime = Date.now();

    // Dispatch to executor
    const result = await dispatchRun(prepareResult.context);
    const dispatchTime = Date.now();

    // Record per-step timing metrics for latency diagnosis
    const steps = [
      { op: "api_step_authorize", ms: timings.authorize - timings.apiStart },
      {
        op: "api_step_validate_and_insert",
        ms: timings.transaction - timings.authorize,
      },
      {
        op: "api_step_callbacks_and_token",
        ms: timings.token - timings.transaction,
      },
      { op: "api_step_build_context", ms: buildContextTime - timings.token },
      { op: "api_step_prepare", ms: prepareTime - buildContextTime },
      { op: "api_step_dispatch", ms: dispatchTime - prepareTime },
      // Sub-step timings within buildExecutionContext (optional — only present for zero path)
      ...(timings.resolveSourceDuration !== undefined
        ? [
            {
              op: "api_build_resolve_source_and_org",
              ms: timings.resolveSourceDuration,
            },
          ]
        : []),
      ...(timings.resolveSecretsDuration !== undefined
        ? [
            {
              op: "api_build_resolve_secrets",
              ms: timings.resolveSecretsDuration,
            },
          ]
        : []),
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
    await markRunFailed(runId, error);
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
export async function resolveStartRunCompose(params: {
  userId: string;
  prompt?: string;
  composeId?: string;
  agentComposeVersionId?: string;
  checkpointId?: string;
  sessionId?: string;
}): Promise<ResolvedStartRunCompose> {
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
 * High-level run entry point — the single public API for CLI run creation.
 *
 * Resolves compose version + org context, creates a run record, builds an
 * infra execution context, and dispatches. Uses infra primitives directly
 * (no zero layer dependency). Callers only need a compose identifier
 * (composeId, versionId, checkpointId, or sessionId).
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

  // 4. Create run record — ConcurrentRunLimitError propagates to API route (returns 429)
  const record = await createRunRecord({
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
    debugNoMockClaude: params.debugNoMockClaude,
    firewallPolicies: params.firewallPolicies,
    allowedConnectorTypes: params.allowedConnectorTypes,
    orgId: authOrgId,
    orgTier: params.orgTier,
  });

  // 5. Generate sandbox token
  const sandboxToken = await generateSandboxToken(params.userId, record.run.id);
  const tokenTime = Date.now();

  try {
    // 6. Register callbacks early so they persist even if context building fails
    if (params.callbacks && params.callbacks.length > 0) {
      await registerCallbacks(record.run.id, params.callbacks);
    }

    // 7. Build execution context (pure infra — all business data pre-resolved by caller)
    const { context } = buildInfraExecutionContext({
      runId: record.run.id,
      userId: params.userId,
      orgId: authOrgId,
      agentComposeVersionId: resolved.agentComposeVersionId,
      agentCompose: record.composeContent,
      prompt: params.prompt,
      sandboxToken,
      appendSystemPrompt: params.appendSystemPrompt,
      vars: params.vars,
      secrets: params.secrets,
      secretConnectorMap: params.secretConnectorMap,
      artifactName: params.artifactName,
      artifactVersion: params.artifactVersion,
      memoryName: params.memoryName,
      volumeVersions: params.volumeVersions,
      environment: params.environment,
      userTimezone: params.userTimezone,
      firewalls: params.firewalls,
      disallowedTools: params.disallowedTools,
      tools: params.tools,
      settings: params.settings,
      resumeSession: params.resumeSession,
      resumeArtifact: params.resumeArtifact,
      agentName: resolved.agentName,
      resumedFromCheckpointId: params.checkpointId,
      continuedFromSessionId: params.sessionId,
      debugNoMockClaude: params.debugNoMockClaude,
    });

    // 8. Dispatch
    const result = await buildAndDispatchRun({
      runId: record.run.id,
      context,
      timings: {
        apiStart: record.apiStartTime,
        authorize: record.authorizeTime,
        transaction: record.transactionTime,
        token: tokenTime,
        resolveSourceDuration: params.resolveSourceDuration,
        resolveSecretsDuration: params.resolveSecretsDuration,
      },
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
    await markRunFailed(record.run.id, error);
    throw error;
  }
}

/**
 * Result of createRunRecord — contains the run record and all metadata
 * needed by buildAndDispatchRun to complete the dispatch pipeline.
 */
export interface CreateRunRecordResult {
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
  const { composeContent, compose } =
    params.preloadedCompose ??
    (await loadCompose(agentComposeVersionId, params.composeId));
  authorizeCompose(userId, params.orgId, compose);
  const authorizeTime = Date.now();

  // Step 3: Validate template vars and image access (for new runs only)
  if (!params.checkpointId && !params.sessionId) {
    await validateComposeRequirements(composeContent);
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
 * Dispatch post-cancellation side effects (Ably notification, callbacks, queue drain).
 * Designed to be called inside `after()` so it runs after the response is sent.
 *
 * Returns `true` when the cancelled run was previously active (running/pending),
 * indicating the caller should also process org credits.
 */
export async function dispatchCancelSideEffects(
  result: CancelRunResult,
  drain: (orgId: string) => Promise<void>,
): Promise<boolean> {
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
          return drain(result.orgId);
        }
      : undefined,
  );

  return shouldDrain;
}
