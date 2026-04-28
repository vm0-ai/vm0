import { eq, and, or } from "drizzle-orm";
import { env } from "../../../env";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { transitionRunStatus, dispatchTerminalSideEffects } from "./run-status";
import { publishRunChangedSafely } from "./run-realtime";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { notFound } from "@vm0/api-services/errors";

import { logger } from "../../shared/logger";
import type { Database } from "../../../types/global";
import type { AgentComposeYaml } from "../agent-compose/types";
import { prepareForExecution } from "./context/execution-preparer";
import { executeRunnerJob } from "./executors/runner-executor";
import type { ExecutorResult, PreparedContext } from "./executors/types";
import type {
  ContextArtifact,
  ExecutionContext,
  DispatchTimings,
} from "./types";
import { recordSandboxOperation } from "../metrics";

import { encryptSecretValue } from "../../shared/crypto/secrets-encryption";
import {
  type RunStatus,
  type GetRunResponse,
} from "@vm0/api-contracts/contracts/runs";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { publishCancelNotification } from "../realtime/client";
import type { CancelRunResult } from "../../zero/zero-run-cancel";

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
 * the error is augmented with runId and sessionId so callers can return
 * partial results (e.g. 201 with status=failed) that still satisfy the
 * required-sessionId response contract.
 */
export interface RunDispatchError extends Error {
  runId?: string;
  sessionId?: string;
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
  volumeVersions?: Record<string, string>;
  callbacks?: Array<{ url: string; secret: string; payload: unknown }>;
  resumedFromCheckpointId?: string;
  agentName?: string;
  modelProvider?: string;
  modelProviderId?: string;
  selectedModelOverride?: string;
  debugNoMockClaude?: boolean;
  debugNoMockCodex?: boolean;
  captureNetworkBodies?: boolean;
  // Caller-resolved org context for variable/storage resolution.
  orgId: string;
  // Caller-resolved org tier for concurrency limit derivation.
  orgTier?: OrgTier;
  // Per-permission policies from zero agent configuration (includes unknownPolicy).
  permissionPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];
  // Custom connector ids the user has authorized for this agent run. See
  // BuildZeroContextParams for the semantic of `undefined` vs. empty array.
  allowedCustomConnectorIds?: string[];
  // Additional volumes to mount (e.g., system skills, custom skills).
  additionalVolumes?: Array<{
    name: string;
    version?: string;
    mountPath: string;
    system?: boolean;
  }>;
  // Pre-loaded compose data. When provided, skips the internal loadCompose() call.
  preloadedCompose?: {
    composeContent: AgentComposeYaml;
    compose: { id: string; userId: string; orgId: string };
  };
  // Origin of the run request (e.g. "cli", "web", "schedule", "slack").
  // Threaded through to queue telemetry so enqueue/dequeue spans can be split
  // by trigger in Axiom; only populated on the zero path.
  triggerSource?: TriggerSource;
}

export interface CreateRunResult {
  runId: string;
  status: RunStatus;
  sandboxId?: string;
  createdAt: Date;
  sessionId: string;
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
    await publishRunChangedSafely(runId, { status: "failed" });
    await dispatchTerminalSideEffects(runId, "failed", errorMessage);
  }

  // Attach run metadata so callers can return partial results. sessionId is
  // always populated post-INSERT (see #10323 — agent_runs.session_id NOT NULL).
  if (error instanceof Error) {
    (error as RunDispatchError).runId = runId;
    const [row] = await globalThis.services.db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (row) {
      (error as RunDispatchError).sessionId = row.sessionId ?? undefined;
    }
  }
}

/**
 * Shared dispatch pipeline for steps 6-10 of the run creation flow.
 * Used by the CLI API route (new runs) and dispatchQueuedZeroRun (dequeued runs).
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

    // Record per-step timing metrics for latency diagnosis.
    // Note: timings.apiStart is captured at the route handler's first line
    // (issue #9936) to anchor end-to-end startup latency. The per-op steps
    // below start from timings.authorize because the route-entry → authorize
    // segment covers many heterogeneous call paths (auth, resolve, pre-flight)
    // whose aggregate is not a meaningful single metric.
    const steps = [
      {
        op: "api_step_validate_and_insert",
        ms: timings.transaction - timings.authorize,
      },
      // Only the chat route stamps both anchors; other callers (telegram,
      // slack, email, github, schedule, voice-chat) leave them undefined, and
      // the split is skipped.
      ...(timings.responseReady !== undefined &&
      timings.dispatchStart !== undefined
        ? [
            {
              op: "api_phase1_post_tx_sync",
              ms: timings.responseReady - timings.transaction,
            },
            {
              op: "api_after_scheduling_gap",
              ms: timings.dispatchStart - timings.responseReady,
            },
            {
              op: "api_phase2_callbacks_token_pure",
              ms: timings.token - timings.dispatchStart,
            },
          ]
        : []),
      // Further split of api_after_scheduling_gap: isolate pure Vercel
      // platform scheduling (response flush + after() fire) from JS-local
      // closure-to-dispatch overhead. Only stamped on the chat path, which
      // captures afterEnterAt at the first synchronous line of the after()
      // closure in zero-run-service.ts.
      ...(timings.responseReady !== undefined &&
      timings.afterEnterAt !== undefined &&
      timings.dispatchStart !== undefined
        ? [
            {
              op: "api_after_schedule_to_closure",
              ms: timings.afterEnterAt - timings.responseReady,
            },
            {
              op: "api_after_closure_to_dispatch",
              ms: timings.dispatchStart - timings.afterEnterAt,
            },
          ]
        : []),
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
 * Run record result — contains the run record and all metadata
 * needed by buildAndDispatchRun to complete the dispatch pipeline.
 */
export interface CreateRunRecordResult {
  run: { id: string; createdAt: Date };
  composeContent: AgentComposeYaml;
  orgId: string;
  apiStartTime: number;
  authorizeTime: number;
  transactionTime: number;
  /**
   * Stamped by the route handler via CreateZeroRunResult.markResponseReady()
   * right before returning HTTP 201. Anchors the Phase-1 residual /
   * after()-scheduling / Phase-2 diagnostic span split. Undefined on non-chat
   * triggers that don't participate in the marker protocol.
   */
  responseReadyAt?: number;
}

/**
 * Parameters for the pure INSERT into agent_runs.
 * Subset of CreateRunParams — only the fields needed for the INSERT.
 */
interface InsertRunParams {
  userId: string;
  orgId: string;
  agentComposeId: string;
  agentComposeVersionId: string;
  prompt: string;
  appendSystemPrompt?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  additionalVolumes?: Array<{
    name: string;
    version?: string;
    mountPath: string;
    system?: boolean;
  }>;
  resumedFromCheckpointId?: string;
  sessionId?: string;
  /**
   * Seed for agent_sessions.artifacts on new runs. Unused when sessionId
   * is provided (existing session row is reused).
   */
  artifacts?: ContextArtifact[];
}

/**
 * Pure INSERT into agent_runs within an existing transaction.
 * For new runs, also creates the agent_sessions row in the same tx so
 * sessionId is known on the first POST response. For continuations, reuses
 * the caller-supplied sessionId. No business logic — caller is responsible
 * for authorization, validation, and concurrency checks.
 */
export async function insertRunRecord(
  tx: Database,
  params: InsertRunParams,
): Promise<{ id: string; createdAt: Date; sessionId: string }> {
  let sessionId: string;
  if (params.sessionId) {
    sessionId = params.sessionId;
  } else {
    const [newSession] = await tx
      .insert(agentSessions)
      .values({
        userId: params.userId,
        orgId: params.orgId,
        agentComposeId: params.agentComposeId,
        artifacts: params.artifacts ?? [],
        conversationId: null,
      })
      .returning({ id: agentSessions.id });

    if (!newSession) {
      throw new Error("Failed to create agent session");
    }
    sessionId = newSession.id;
  }

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
      additionalVolumes: params.additionalVolumes ?? null,
      resumedFromCheckpointId: params.resumedFromCheckpointId ?? null,
      continuedFromSessionId: params.sessionId ?? null,
      sessionId,
      lastHeartbeatAt: new Date(),
    })
    .returning();

  if (!newRun) {
    throw new Error("Failed to create run record");
  }

  return { id: newRun.id, createdAt: newRun.createdAt, sessionId };
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
