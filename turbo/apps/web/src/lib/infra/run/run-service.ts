import { eq, and, or, sql } from "drizzle-orm";
import { env } from "../../../env";
import { agentRuns } from "../../../db/schema/agent-run";
import { transitionRunStatus, dispatchTerminalSideEffects } from "./run-status";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../db/schema/agent-compose";
import { agentRunCallbacks } from "../../../db/schema/agent-run-callback";
import { notFound, badRequest, forbidden } from "../../shared/errors";
import { getCachedUser } from "../../auth/user-cache-service";

import { logger } from "../../shared/logger";
import type { Database } from "../../../types/global";
import type { AgentComposeYaml } from "../agent-compose/types";
import { prepareForExecution } from "./context/execution-preparer";
import { executeRunnerJob } from "./executors/runner-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import { generateSandboxToken } from "../../auth/sandbox-token";
import type { ExecutionContext, DispatchTimings, ResumeSession } from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import { buildInfraExecutionContext } from "./context/build-context";
import { recordSandboxOperation } from "../metrics";

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

import {
  checkRunConcurrencyLimit,
  authorizeCompose,
  validateComposeRequirements,
} from "../../zero/zero-run-policy";
import { resolveStartRunCompose } from "../../zero/zero-run-validation";

const log = logger("service:run");

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
  captureNetworkBodies?: boolean;
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
  captureNetworkBodies?: boolean;
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
        runId,
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
  // 0. Gate captureNetworkBodies to @vm0.ai accounts in production
  if (params.captureNetworkBodies && env().VERCEL_ENV === "production") {
    const { email } = await getCachedUser(params.userId);
    if (!email.endsWith("@vm0.ai")) {
      throw forbidden(
        "captureNetworkBodies is restricted to internal accounts",
      );
    }
  }

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
    captureNetworkBodies: params.captureNetworkBodies,
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
      captureNetworkBodies: params.captureNetworkBodies,
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
 * Parameters for the pure INSERT into agent_runs.
 * Subset of CreateRunParams — only the fields needed for the INSERT.
 */
interface InsertRunParams {
  userId: string;
  orgId: string;
  agentComposeVersionId: string;
  prompt: string;
  appendSystemPrompt?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  resumedFromCheckpointId?: string;
  sessionId?: string;
}

/**
 * Pure INSERT into agent_runs within an existing transaction.
 * No business logic — caller is responsible for authorization,
 * validation, and concurrency checks.
 */
export async function insertRunRecord(
  tx: Database,
  params: InsertRunParams,
): Promise<{ id: string; createdAt: Date }> {
  const [newRun] = await tx
    .insert(agentRuns)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      agentComposeVersionId: params.agentComposeVersionId,
      status: "pending",
      prompt: params.prompt,
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
 * Used by startRun() for the legacy CLI path.
 *
 * @throws ForbiddenError - user cannot access compose
 * @throws BadRequestError - validation failure (missing vars, mutual exclusivity)
 * @throws NotFoundError - compose version not found
 * @throws ConcurrentRunLimitError - org has reached concurrent run limit
 */
async function createRunRecord(
  params: CreateRunParams,
): Promise<CreateRunRecordResult> {
  const apiStartTime = Date.now();

  // Steps 1-2: Load compose and authorize
  const { composeContent, compose } =
    params.preloadedCompose ??
    (await loadCompose(params.agentComposeVersionId, params.composeId));
  authorizeCompose(params.userId, params.orgId, compose);
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

  const orgId = params.orgId;

  // Step 5: Concurrency check + INSERT in a transaction with advisory lock
  const run = await globalThis.services.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
    await checkRunConcurrencyLimit(orgId, params.orgTier ?? "free", tx);
    return insertRunRecord(tx, params);
  });

  const transactionTime = Date.now();
  log.debug(`Created run ${run.id} for user ${params.userId}`);

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
