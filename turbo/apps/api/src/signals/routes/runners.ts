import { command } from "ccstate";
import { connectorSlugSchema } from "@vm0/api-contracts/contracts/connector-identity";
import {
  compatibleStoredExecutionContextSchema,
  elapsedSinceApiStartMs,
  NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  RUNNER_CANCELLATION_RECOVERY_CAPABILITY,
  runnersNetworkPolicyRefreshContract,
  runnersBuiltinFirewallsResolveContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
  storedConnectorPermissionBaselineSchema,
  type CompatibleStoredExecutionContext,
  type ExecutionContext,
  type HeldSessionState,
  type SessionHistoryDownloadSource,
  type StoredConnectorPermissionBaseline,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import {
  runStatusSchema,
  type RunStatus,
} from "@vm0/api-contracts/contracts/runs";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { blobs } from "@vm0/db/schema/blob";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { runnerAuth$, type RunnerAuthContext } from "../auth/runner-auth";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$, type Db } from "../external/db";
import {
  generatePresignedGetUrl,
  publicS3DownloadSource,
  S3ObjectSizeLimitError,
  s3ObjectContentLength,
} from "../external/s3";
import {
  createRunnerGroupRealtimeToken,
  publishRunChangedForUserSafely,
} from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { executeRawRows } from "../../lib/db-raw-rows";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { generateSandboxToken } from "../auth/tokens";
import { decryptPersistentSecretsMap } from "../services/crypto.utils";
import { dispatchCompleteSideEffects$ } from "../services/agent-webhook-complete.service";
import { loadConnectorRuntimeSnapshot } from "../services/connector-catalog-runtime.service";
import { loadConnectorRunnerFirewallCatalog } from "../services/connector-runner-firewall-catalog.service";
import {
  networkPolicyRefreshesRecord,
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshConnectorSlugs,
  resolveActiveNetworkPolicyRefreshes,
  resolveActiveNetworkPolicyRefreshesFromBaseline,
} from "../services/zero-user-permission-grants.service";
import {
  type CompressedSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  resumeSessionHistoryRawBlobKey,
  SESSION_HISTORY_ENCODING_IDENTITY,
  tryNormalizeSessionHistoryBlobEncoding,
} from "../services/session-history-blobs";
import {
  runnerSessionAffinityPollPriority,
  runnerSessionAffinityLookupError,
  runnerSessionAffinityProtection,
  runnerSessionAffinityTelemetryResource,
} from "../services/runner-session-affinity";
import type { RouteEntry } from "../route-entry";
import { settle, tapError } from "../utils";

const L = logger("Runners");

type SandboxOperationAttrs = Parameters<
  typeof recordSandboxOperations
>[0][number];

const STALE_RUNNER_THRESHOLD_MS = 5 * 60 * 1000;
const INVALID_EXECUTION_CONTEXT_ERROR =
  "Runner job missing valid execution context";
const MAX_VALIDATION_ISSUES_TO_LOG = 10;
const RESUME_SESSION_HISTORY_URL_TTL_SECONDS = 60 * 60;
const RESUME_SESSION_HISTORY_LOAD_ERROR =
  "Runner job missing resume session history";
const RESUME_SESSION_HISTORY_INVALID_ERROR =
  "Runner job has invalid resume session history";

function mergeClaimVars(args: {
  readonly runVars: Record<string, string> | null;
  readonly connectorVars: Record<string, string> | null | undefined;
}): Record<string, string> | null {
  const merged: Record<string, string> = {};
  if (args.runVars) {
    Object.assign(merged, args.runVars);
  }
  if (args.connectorVars) {
    Object.assign(merged, args.connectorVars);
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

interface ClaimFailedSideEffectArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly error: string;
}

class ResumeSessionHistoryLoadError extends Error {
  constructor(
    readonly hash: string,
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "ResumeSessionHistoryLoadError";
  }
}

function isResumeSessionHistoryLoadError(
  error: unknown,
): error is ResumeSessionHistoryLoadError {
  return error instanceof ResumeSessionHistoryLoadError;
}

type ClaimRouteTimingSpanKind = "top_level" | "nested";
type ClaimNetworkPolicyRefreshPath =
  | "baseline"
  | "baseline_empty"
  | "full_missing_baseline"
  | "full_invalid_baseline"
  | "full_incompatible_baseline";
type ClaimRouteTimingActionType =
  | "claim_route_request_prepare"
  | "claim_route_lookup_authorization"
  | "claim_route_context_parse"
  | "claim_route_secret_materialization"
  | "claim_route_response_assembly"
  | "claim_route_response_network_policy_refresh"
  | "claim_route_response_resume_session"
  | "claim_route_transition_running"
  | "claim_route_transition_execute";

interface ClaimRouteTimingRecord {
  readonly actionType: ClaimRouteTimingActionType;
  readonly spanKind: ClaimRouteTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly fallbackReason?: "invalid_keys";
  readonly policyRefreshPath?: ClaimNetworkPolicyRefreshPath;
}

class ClaimRouteTimingCollector {
  private readonly records: ClaimRouteTimingRecord[] = [];

  recordElapsed(
    actionType: ClaimRouteTimingActionType,
    spanKind: ClaimRouteTimingSpanKind,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.records.push({
      actionType,
      spanKind,
      durationMs: Math.max(0, finishedAt - startedAt),
      timestamp: new Date(finishedAt).toISOString(),
    });
  }

  measure<T>(
    actionType: ClaimRouteTimingActionType,
    spanKind: ClaimRouteTimingSpanKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    return operation().finally(() => {
      this.recordElapsed(actionType, spanKind, startedAt);
    });
  }

  measureInvalidKeySecretMaterialization<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    return operation().finally(() => {
      const finishedAt = now();
      this.records.push({
        actionType: "claim_route_secret_materialization",
        spanKind: "top_level",
        durationMs: Math.max(0, finishedAt - startedAt),
        timestamp: new Date(finishedAt).toISOString(),
        fallbackReason: "invalid_keys",
      });
    });
  }

  async measureNetworkPolicyRefresh<T>(
    operation: () => Promise<{
      readonly value: T;
      readonly path: ClaimNetworkPolicyRefreshPath;
    }>,
  ): Promise<T> {
    const startedAt = now();
    const result = await settle(operation());
    const finishedAt = now();
    this.records.push({
      actionType: "claim_route_response_network_policy_refresh",
      spanKind: "nested",
      durationMs: Math.max(0, finishedAt - startedAt),
      timestamp: new Date(finishedAt).toISOString(),
      ...(result.ok ? { policyRefreshPath: result.value.path } : {}),
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.value.value;
  }

  flush(args: {
    readonly runId: string;
    readonly runnerGroup: string;
    readonly profile: string;
    readonly authType: RunnerAuthContext["type"];
    readonly discoverySource: string | undefined;
    readonly pollReason: string | undefined;
  }): void {
    const records = this.records.splice(0);
    const dimensions: Record<string, string> = {
      runner_group: args.runnerGroup,
      profile: args.profile,
      auth_type: args.authType,
    };
    if (args.discoverySource) {
      dimensions.discovery_source = args.discoverySource;
    }
    if (args.pollReason) {
      dimensions.poll_reason = args.pollReason;
    }

    recordSandboxOperations(
      records.map((record) => {
        return {
          sandboxType: "runner",
          actionType: record.actionType,
          durationMs: record.durationMs,
          success: true,
          runId: args.runId,
          timestamp: record.timestamp,
          dimensions: {
            ...dimensions,
            span_kind: record.spanKind,
            ...(record.fallbackReason
              ? { fallback_reason: record.fallbackReason }
              : {}),
            ...(record.policyRefreshPath
              ? { policy_refresh_path: record.policyRefreshPath }
              : {}),
          },
        };
      }),
    );
  }
}

interface ValidationIssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

function validationIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "<root>";
  }
  return path
    .map((segment) => {
      return String(segment);
    })
    .join(".");
}

function warnInvalidStoredExecutionContext(
  runId: string,
  issues: readonly ValidationIssueLike[],
): void {
  const validationIssueCount = issues.length;
  const validationIssues = issues
    .slice(0, MAX_VALIDATION_ISSUES_TO_LOG)
    .map((issue) => {
      return {
        path: validationIssuePath(issue.path),
        code: issue.code,
        message: issue.message,
      };
    });
  L.warn(INVALID_EXECUTION_CONTEXT_ERROR, {
    runId,
    validationIssueCount,
    validationIssues,
    validationIssuesOmitted: Math.max(
      0,
      validationIssueCount - MAX_VALIDATION_ISSUES_TO_LOG,
    ),
  });
}

const unauthorizedNotAuthenticated = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    }),
  }),
});

const unauthorizedAuthenticationRequired = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Authentication required",
      code: "UNAUTHORIZED",
    }),
  }),
});

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: {
      error: { message, code: "FORBIDDEN" },
    },
  };
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
}

function canonicalizeHeldSessionStates(
  states: readonly HeldSessionState[] | undefined,
): HeldSessionState[] | undefined {
  return states?.map((state) => {
    const cliAgentSessionId = state.sessionId;
    return {
      sessionId: cliAgentSessionId,
      ...(state.reuseKey ? { reuseKey: state.reuseKey } : {}),
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
      ...(state.reusableSandbox
        ? {
            reusableSandbox: {
              profile: state.reusableSandbox.profile,
              ...(state.reusableSandbox.historyGenerationRunId
                ? {
                    historyGenerationRunId:
                      state.reusableSandbox.historyGenerationRunId,
                  }
                : {}),
            },
          }
        : {}),
      ...(state.workspaceCaches
        ? {
            workspaceCaches: state.workspaceCaches.map((workspaceCache) => {
              return {
                profile: workspaceCache.profile,
                ...(workspaceCache.workspaceAffinityVersion
                  ? {
                      workspaceAffinityVersion:
                        workspaceCache.workspaceAffinityVersion,
                    }
                  : {}),
              };
            }),
          }
        : {}),
    };
  });
}

const heartbeatBody$ = bodyResultOf(runnersHeartbeatContract.heartbeat);

const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedNotAuthenticated;
  }

  const body = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  if (!isOfficialRunnerGroup(body.data.group)) {
    return badRequestMessage("Invalid runner group");
  }

  const heldSessionStates =
    canonicalizeHeldSessionStates(body.data.heldSessionStates) ?? [];
  const admittableProfiles = body.data.admittableProfiles;
  const currentDate = nowDate();
  const snapshotOrder = {
    generation: body.data.snapshotGeneration,
    sequence: body.data.snapshotSequence,
  };
  const db = set(writeDb$);
  await db
    .insert(runnerState)
    .values({
      runnerId: body.data.runnerId,
      runnerName: body.data.runnerName,
      runnerGroup: body.data.group,
      heartbeatGeneration: snapshotOrder.generation,
      heartbeatSequence: snapshotOrder.sequence,
      totalVcpu: body.data.totalVcpu,
      totalMemoryMb: body.data.totalMemoryMb,
      maxConcurrent: body.data.maxConcurrent,
      allocatedVcpu: body.data.allocatedVcpu,
      allocatedMemoryMb: body.data.allocatedMemoryMb,
      runningCount: body.data.runningCount,
      admittableProfiles,
      heldSessionStates,
      mode: body.data.mode,
      lastSeenAt: currentDate,
    })
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: {
        runnerName: body.data.runnerName,
        runnerGroup: body.data.group,
        heartbeatGeneration: snapshotOrder.generation,
        heartbeatSequence: snapshotOrder.sequence,
        totalVcpu: body.data.totalVcpu,
        totalMemoryMb: body.data.totalMemoryMb,
        maxConcurrent: body.data.maxConcurrent,
        allocatedVcpu: body.data.allocatedVcpu,
        allocatedMemoryMb: body.data.allocatedMemoryMb,
        runningCount: body.data.runningCount,
        admittableProfiles,
        heldSessionStates,
        mode: body.data.mode,
        lastSeenAt: currentDate,
      },
      setWhere: or(
        lt(runnerState.heartbeatGeneration, snapshotOrder.generation),
        and(
          eq(runnerState.heartbeatGeneration, snapshotOrder.generation),
          lt(runnerState.heartbeatSequence, snapshotOrder.sequence),
        ),
      ),
    });
  signal.throwIfAborted();

  await db
    .delete(runnerState)
    .where(
      lt(
        runnerState.lastSeenAt,
        new Date(currentDate.getTime() - STALE_RUNNER_THRESHOLD_MS),
      ),
    );
  signal.throwIfAborted();

  return { status: 200 as const, body: { ok: true as const } };
});

const pollBody$ = bodyResultOf(runnersPollContract.poll);

function recordPollTimingMetrics(args: {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly pollReason: string | undefined;
  readonly sessionAffinity: string;
  readonly sessionAffinityResource: string;
  readonly historyGenerationAffinity: string;
  readonly queueCreatedAtMs: number;
  readonly pollRequestStartedAtMs: number;
  readonly pendingJobLookupStartedAtMs: number;
  readonly pendingJobLookupFinishedAtMs: number;
  readonly pollResponseAtMs: number;
}): void {
  const dimensions: Record<string, string> = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    auth_type: args.authType,
    session_affinity: args.sessionAffinity,
    session_affinity_resource: args.sessionAffinityResource,
    history_generation_affinity: args.historyGenerationAffinity,
  };
  if (args.pollReason) {
    dimensions.poll_reason = args.pollReason;
  }

  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "runner_poll_pending_job_lookup",
      durationMs: Math.max(
        0,
        args.pendingJobLookupFinishedAtMs - args.pendingJobLookupStartedAtMs,
      ),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_poll_request_to_job_response",
      durationMs: Math.max(
        0,
        args.pollResponseAtMs - args.pollRequestStartedAtMs,
      ),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_queue_to_poll_response",
      durationMs: Math.max(0, args.pollResponseAtMs - args.queueCreatedAtMs),
      success: true,
      runId: args.runId,
      dimensions,
    },
  ]);
}

function runnerPollPriorityOrder(
  db: Pick<Db, "select">,
  args: {
    readonly runnerId: string | undefined;
    readonly runnerGroup: string;
    readonly currentDate: Date;
  },
): SQL[] {
  if (!args.runnerId) {
    return [];
  }
  return [
    desc(
      runnerSessionAffinityPollPriority({
        db,
        runnerId: args.runnerId,
        runnerGroup: args.runnerGroup,
        currentDate: args.currentDate,
      }),
    ),
  ];
}

const pollInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const pollRequestStartedAtMs = now();
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedAuthenticationRequired;
  }

  const body = await get(pollBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const { group, supportedProfiles, excludedRunIds } = body.data;
  const whereConditions: SQL[] = [
    eq(runnerJobQueue.runnerGroup, group),
    gt(runnerJobQueue.expiresAt, sql`now()`),
    eq(agentRuns.status, "pending"),
  ];

  if (auth.type === "official-runner") {
    if (!isOfficialRunnerGroup(group)) {
      return forbidden("Official runners can only poll vm0/* groups");
    }
  } else {
    if (!isOfficialRunnerGroup(group)) {
      return forbidden("Only vm0/* runner groups are supported");
    }
    whereConditions.push(eq(agentRuns.userId, auth.userId));
  }

  whereConditions.push(inArray(runnerJobQueue.profile, supportedProfiles));
  if (excludedRunIds && excludedRunIds.length > 0) {
    whereConditions.push(notInArray(runnerJobQueue.runId, excludedRunIds));
  }
  const db = set(writeDb$);
  const pendingJobLookupStartedAtMs = now();
  const currentDate = nowDate();
  const sessionAffinityPriorityOrder = runnerPollPriorityOrder(db, {
    runnerId: body.data.runnerId,
    runnerGroup: group,
    currentDate,
  });
  const [pendingJob] = await db
    .select({
      runId: runnerJobQueue.runId,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      agentComposeVersionId: agentRuns.agentComposeVersionId,
      vars: agentRuns.vars,
      profile: runnerJobQueue.profile,
      cliAgentSessionId: runnerJobQueue.cliAgentSessionId,
      reuseKey: runnerJobQueue.reuseKey,
      historyGenerationRunId:
        sql`${runnerJobQueue.executionContext}->'resumeSession'->>'historyGenerationRunId'`.mapWith(
          nullableDriverValueDecoder(pgTextDecoder),
        ),
      createdAt: runnerJobQueue.createdAt,
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .where(and(...whereConditions))
    .orderBy(
      ...sessionAffinityPriorityOrder,
      runnerJobQueue.createdAt,
      runnerJobQueue.runId,
    )
    .limit(1);
  signal.throwIfAborted();
  const pendingJobLookupFinishedAtMs = now();

  if (!pendingJob) {
    return { status: 200 as const, body: { job: null } };
  }

  const affinity =
    (await tapError(
      runnerSessionAffinityProtection({
        db,
        runnerGroup: group,
        profile: pendingJob.profile,
        reuseKey: pendingJob.reuseKey,
        historyGenerationRunId: pendingJob.historyGenerationRunId ?? undefined,
        createdAt: pendingJob.createdAt,
        currentDate,
      }),
      (error) => {
        L.warn("Failed to resolve runner session affinity for poll response", {
          runId: pendingJob.runId,
          runnerGroup: group,
          profile: pendingJob.profile,
          error,
        });
      },
    )) ?? runnerSessionAffinityLookupError();
  signal.throwIfAborted();
  const pollResponseAtMs = now();
  recordPollTimingMetrics({
    runId: pendingJob.runId,
    runnerGroup: group,
    profile: pendingJob.profile,
    authType: auth.type,
    pollReason: body.data.telemetry?.pollReason,
    sessionAffinity: affinity.status,
    sessionAffinityResource: runnerSessionAffinityTelemetryResource(affinity),
    historyGenerationAffinity: affinity.historyGenerationStatus,
    queueCreatedAtMs: pendingJob.createdAt.getTime(),
    pollRequestStartedAtMs,
    pendingJobLookupStartedAtMs,
    pendingJobLookupFinishedAtMs,
    pollResponseAtMs,
  });

  return {
    status: 200 as const,
    body: {
      job: {
        runId: pendingJob.runId,
        prompt: pendingJob.prompt,
        appendSystemPrompt: pendingJob.appendSystemPrompt,
        agentComposeVersionId: pendingJob.agentComposeVersionId,
        vars: (pendingJob.vars as Record<string, string>) ?? null,
        experimentalProfile: pendingJob.profile,
        cliAgentSessionId: pendingJob.cliAgentSessionId,
        reuseKey: pendingJob.reuseKey,
        historyGenerationRunId: pendingJob.historyGenerationRunId ?? undefined,
        historyGenerationAffinityProtectedUntil:
          affinity.historyGenerationProtectedUntil?.toISOString() ?? null,
        affinityProtectedUntil: affinity.protectedUntil?.toISOString() ?? null,
        sessionAffinityResource: affinity.resource ?? undefined,
      },
    },
  };
});

const claimBody$ = bodyResultOf(runnersJobClaimContract.claim);
const networkPolicyRefreshBody$ = bodyResultOf(
  runnersNetworkPolicyRefreshContract.refresh,
);
const builtinFirewallsResolveBody$ = bodyResultOf(
  runnersBuiltinFirewallsResolveContract.resolve,
);

interface ClaimableJob {
  readonly job: Pick<
    typeof runnerJobQueue.$inferSelect,
    "runnerGroup" | "profile" | "reuseKey" | "executionContext" | "createdAt"
  >;
  readonly run: ClaimedRun;
}

interface ClaimedRun {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly agentComposeVersionId: string | null;
  readonly vars: unknown;
}

interface RunNetworkPolicyScope {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly status: RunStatus;
}

type ClaimLookupResult = ClaimableJob | ReturnType<typeof notFound>;

function isClaimableJob(value: ClaimLookupResult): value is ClaimableJob {
  return "job" in value;
}

async function getRunNetworkPolicyScope(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<RunNetworkPolicyScope | undefined> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      agentId: agentSessions.agentComposeId,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return row
    ? {
        ...row,
        status: runStatusSchema.parse(row.status),
      }
    : undefined;
}

function runnerRunAuthorizationError(
  auth: RunnerAuthContext,
  run: Pick<RunNetworkPolicyScope, "userId">,
) {
  if (auth.type === "official-runner") {
    return null;
  }
  return run.userId === auth.userId
    ? null
    : forbidden("Run does not belong to user");
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

async function getClaimableJob(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<ClaimLookupResult> {
  const [jobWithRun] = await db
    .select({
      job: {
        runnerGroup: runnerJobQueue.runnerGroup,
        profile: runnerJobQueue.profile,
        reuseKey: runnerJobQueue.reuseKey,
        executionContext: runnerJobQueue.executionContext,
        createdAt: runnerJobQueue.createdAt,
      },
      run: {
        id: agentRuns.id,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        agentId: agentSessions.agentComposeId,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        vars: agentRuns.vars,
      },
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      and(
        eq(runnerJobQueue.runId, runId),
        gt(runnerJobQueue.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (jobWithRun) {
    return jobWithRun;
  }
  return notFound("Job not found in queue");
}

function claimAuthorizationError(
  auth: RunnerAuthContext,
  jobWithRun: ClaimableJob,
) {
  if (auth.type === "official-runner") {
    return isOfficialRunnerGroup(jobWithRun.job.runnerGroup)
      ? null
      : forbidden("Official runners can only claim jobs from vm0/* groups");
  }

  if (jobWithRun.run.userId !== auth.userId) {
    return forbidden("Job does not belong to user");
  }
  return isOfficialRunnerGroup(jobWithRun.job.runnerGroup)
    ? null
    : forbidden("Only vm0/* runner groups are supported");
}

type ClaimTransitionResult =
  | { readonly status: "claimed"; readonly claimedAt: Date }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };
type ClaimedTransitionResult = Extract<
  ClaimTransitionResult,
  { readonly status: "claimed" }
>;
type FailedClaimTransitionResult = Exclude<
  ClaimTransitionResult,
  { readonly status: "claimed" }
>;

function claimTransitionErrorResponse(result: FailedClaimTransitionResult) {
  if (result.status === "job-not-found") {
    return notFound("Job not found in queue");
  }
  return notFound("Run not found");
}

const claimTransitionSqlRowSchema = z.object({
  status: z.enum([
    "claimed",
    "job-not-found",
    "run-not-found",
    "invariant-error",
  ]),
  claimedAtMs: z.number().nullable(),
});

async function lockClaimRun(
  db: Pick<Db, "select">,
  runId: string,
): Promise<{ readonly id: string; readonly status: string } | undefined> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  return run;
}

async function lockRunnerJob(
  db: Pick<Db, "select">,
  runId: string,
): Promise<
  { readonly runId: string; readonly isExpired: boolean } | undefined
> {
  const [row] = await db
    .select({
      runId: runnerJobQueue.runId,
      isExpired: lte(runnerJobQueue.expiresAt, sql`now()`).mapWith(
        pgBooleanDecoder,
      ),
    })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .for("update");
  return row;
}

async function transitionClaimedJobToRunning(
  db: Db,
  runId: string,
  cancellationRecoverySupported: boolean,
  signal: AbortSignal,
  timing: ClaimRouteTimingCollector,
): Promise<ClaimTransitionResult> {
  return await db.transaction(async (tx) => {
    const result = await timing.measure(
      "claim_route_transition_execute",
      "nested",
      async () => {
        // Materialized outputs make the row locks depend on run, then queue.
        return await executeRawRows(
          tx,
          sql`
          WITH locked_run AS MATERIALIZED (
            SELECT
              ${agentRuns.id} AS "id",
              ${agentRuns.status} AS "status"
            FROM ${agentRuns}
            WHERE ${eq(agentRuns.id, runId)}
            FOR UPDATE
          ),
          locked_job AS MATERIALIZED (
            SELECT
              ${runnerJobQueue.runId} AS "runId",
              ${lte(runnerJobQueue.expiresAt, sql`now()`)} AS "isExpired"
            FROM ${runnerJobQueue}
            INNER JOIN locked_run
              ON locked_run."id" = ${runnerJobQueue.runId}
            FOR UPDATE OF ${runnerJobQueue}
          ),
          claim_clock AS MATERIALIZED (
            SELECT
              date_trunc(
                'milliseconds',
                clock_timestamp() AT TIME ZONE 'UTC'
              ) AS "claimedAt"
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            WHERE
              locked_run."status" = 'pending'
              AND NOT locked_job."isExpired"
          ),
          updated_run AS (
            UPDATE ${agentRuns}
            SET
              status = 'running',
              started_at = claim_clock."claimedAt",
              last_heartbeat_at = claim_clock."claimedAt",
              cancellation_recovery_completed = ${cancellationRecoverySupported ? false : null}
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            CROSS JOIN claim_clock
            WHERE ${and(
              eq(agentRuns.id, sql`locked_run."id"`),
              eq(agentRuns.status, sql`'pending'`),
            )}
            RETURNING ${agentRuns.id} AS "id", ${agentRuns.startedAt} AS "claimedAt"
          ),
          deleted_job AS (
            DELETE FROM ${runnerJobQueue}
            USING locked_run, locked_job
            WHERE ${and(
              eq(runnerJobQueue.runId, sql`locked_job."runId"`),
              sql`locked_job."runId" = locked_run."id"`,
              sql`(
                locked_run."status" <> 'pending'
                OR EXISTS (
                  SELECT 1
                  FROM updated_run
                  WHERE updated_run."id" = locked_run."id"
                )
              )`,
            )}
            RETURNING ${runnerJobQueue.runId} AS "runId"
          )
          SELECT
            CASE
              WHEN NOT EXISTS (SELECT 1 FROM locked_run)
                THEN 'run-not-found'
              WHEN EXISTS (
                SELECT 1
                FROM locked_run
                WHERE locked_run."status" <> 'pending'
              )
                THEN 'run-not-found'
              WHEN NOT EXISTS (SELECT 1 FROM locked_job)
                OR EXISTS (
                  SELECT 1
                  FROM locked_job
                  WHERE locked_job."isExpired"
                )
                THEN 'job-not-found'
              WHEN EXISTS (SELECT 1 FROM updated_run)
                AND EXISTS (SELECT 1 FROM deleted_job)
                THEN 'claimed'
              ELSE 'invariant-error'
            END AS "status",
            (
              SELECT
                (
                  EXTRACT(EPOCH FROM updated_run."claimedAt") * 1000
                )::double precision
              FROM updated_run
            ) AS "claimedAtMs"
          `,
          claimTransitionSqlRowSchema,
        );
      },
    );
    signal.throwIfAborted();
    const row = result[0];
    if (!row || row.status === "invariant-error") {
      throw new Error("Runner job claim transition violated its invariant");
    }
    if (row.status === "claimed") {
      if (row.claimedAtMs === null) {
        throw new Error("Claimed runner job is missing its transition time");
      }
      return { status: "claimed", claimedAt: new Date(row.claimedAtMs) };
    }
    return { status: row.status };
  });
}

type PoisonJobResult =
  | { readonly status: "failed" }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };
type FailedPoisonJobResult = Exclude<
  PoisonJobResult,
  { readonly status: "failed" }
>;

function poisonJobErrorResponse(result: FailedPoisonJobResult) {
  if (result.status === "job-not-found") {
    return notFound("Job not found in queue");
  }
  return notFound("Run not found");
}

async function failPoisonQueuedJob(
  db: Db,
  runId: string,
  errorMessage: string,
  signal: AbortSignal,
): Promise<PoisonJobResult> {
  return await db.transaction(async (tx) => {
    const run = await lockClaimRun(tx, runId);
    signal.throwIfAborted();
    if (!run) {
      return { status: "run-not-found" };
    }
    if (run.status !== "pending") {
      await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
      signal.throwIfAborted();
      return { status: "run-not-found" };
    }

    const job = await lockRunnerJob(tx, runId);
    signal.throwIfAborted();
    if (!job || job.isExpired) {
      return { status: "job-not-found" };
    }

    const failedAt = nowDate();
    const [updatedRun] = await tx
      .update(agentRuns)
      .set({
        status: "failed",
        completedAt: failedAt,
        error: errorMessage,
      })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "pending")))
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!updatedRun) {
      throw new Error("Locked pending run was not failed");
    }

    await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
    signal.throwIfAborted();

    return { status: "failed" as const };
  });
}

type PreparedSecretValuesResult =
  | {
      readonly status: "resolved";
      readonly secretValues: string[] | null;
    }
  | {
      readonly status: "invalid-keys";
    };

type ConnectorPermissionBaselineRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "valid";
      readonly value: StoredConnectorPermissionBaseline;
    };

function decodeCompatibleStoredExecutionContext(
  context: CompatibleStoredExecutionContext,
): {
  readonly context: StoredExecutionContext;
  readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
} {
  const {
    connectorPermissionBaseline: rawConnectorPermissionBaseline,
    ...contextWithoutConnectorPermissionBaseline
  } = context;
  if (rawConnectorPermissionBaseline === undefined) {
    return {
      context: contextWithoutConnectorPermissionBaseline,
      connectorPermissionBaseline: { kind: "missing" },
    };
  }
  const baselineResult = storedConnectorPermissionBaselineSchema.safeParse(
    rawConnectorPermissionBaseline,
  );
  if (!baselineResult.success) {
    return {
      context: contextWithoutConnectorPermissionBaseline,
      connectorPermissionBaseline: { kind: "invalid" },
    };
  }
  return {
    context: {
      ...contextWithoutConnectorPermissionBaseline,
      connectorPermissionBaseline: baselineResult.data,
    },
    connectorPermissionBaseline: {
      kind: "valid",
      value: baselineResult.data,
    },
  };
}

function preparedSecretValuesForRunner(
  storedContext: StoredExecutionContext,
): PreparedSecretValuesResult {
  const keys = storedContext.secretValueEnvironmentKeys;
  if (keys === null) {
    return { status: "resolved", secretValues: null };
  }

  const secretValues: string[] = [];
  for (const key of keys) {
    if (
      !storedContext.environment ||
      !Object.hasOwn(storedContext.environment, key)
    ) {
      return { status: "invalid-keys" };
    }
    const value = storedContext.environment[key];
    if (typeof value !== "string") {
      return { status: "invalid-keys" };
    }
    secretValues.push(value);
  }
  return { status: "resolved", secretValues };
}

async function secretValuesForRunner(
  storedContext: StoredExecutionContext,
  timing: ClaimRouteTimingCollector,
): Promise<string[] | null> {
  const prepared = preparedSecretValuesForRunner(storedContext);
  if (prepared.status === "resolved") {
    return prepared.secretValues;
  }

  return await timing.measureInvalidKeySecretMaterialization(async () => {
    const secretsMap = await decryptPersistentSecretsMap(
      storedContext.encryptedSecrets,
      {},
    );
    if (!secretsMap) {
      return null;
    }

    const envValues = storedContext.environment
      ? new Set(Object.values(storedContext.environment))
      : new Set<string>();
    return Object.values(secretsMap).filter((value) => {
      return envValues.has(value);
    });
  });
}

function connectorPermissionBaselineMatchesStoredContext(
  storedContext: StoredExecutionContext,
  baseline: StoredConnectorPermissionBaseline,
): boolean {
  const baselineConnectorSlugs = Object.keys(baseline.connectors);
  const storedBuiltinConnectorSlugs = new Set(
    (storedContext.firewalls ?? []).flatMap((firewall) => {
      return firewall.kind === "builtin" &&
        connectorSlugSchema.safeParse(firewall.name).success
        ? [firewall.name]
        : [];
    }),
  );
  const storedNetworkPolicies = storedContext.networkPolicies ?? {};
  return (
    baselineConnectorSlugs.length === storedBuiltinConnectorSlugs.size &&
    baselineConnectorSlugs.every((connectorSlug) => {
      return (
        storedBuiltinConnectorSlugs.has(connectorSlug) &&
        Object.hasOwn(storedNetworkPolicies, connectorSlug)
      );
    })
  );
}

async function refreshClaimNetworkPolicies(args: {
  readonly db: Db;
  readonly run: ClaimedRun;
  readonly storedContext: StoredExecutionContext;
  readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
  readonly timing: ClaimRouteTimingCollector;
}): Promise<
  Pick<StoredExecutionContext, "networkPolicies" | "networkPolicyRefreshes">
> {
  const storedNetworkPolicies = args.storedContext.networkPolicies ?? {};
  const networkPolicyConnectorSlugs = Object.keys(storedNetworkPolicies);
  if (networkPolicyConnectorSlugs.length === 0) {
    return {
      networkPolicies: args.storedContext.networkPolicies,
      networkPolicyRefreshes: undefined,
    };
  }

  return await args.timing.measureNetworkPolicyRefresh(async () => {
    const scope = {
      orgId: args.run.orgId,
      userId: args.run.userId,
      agentId: args.run.agentId,
    };
    const fullRefresh = async (
      path: Extract<ClaimNetworkPolicyRefreshPath, `full_${string}`>,
    ) => {
      const connectorCatalogSnapshot = await loadConnectorRuntimeSnapshot(
        args.db,
      );
      const connectorSlugs = networkPolicyRefreshConnectorSlugs(
        connectorCatalogSnapshot.serverFirewalls,
        networkPolicyConnectorSlugs,
      );
      const refreshes =
        connectorSlugs.length === 0
          ? []
          : await resolveActiveNetworkPolicyRefreshes(
              args.db,
              scope,
              connectorSlugs,
              connectorCatalogSnapshot,
            );
      return { refreshes, path };
    };

    const selectRefresh = async () => {
      if (args.connectorPermissionBaseline.kind === "missing") {
        return await fullRefresh("full_missing_baseline");
      }
      if (args.connectorPermissionBaseline.kind === "invalid") {
        return await fullRefresh("full_invalid_baseline");
      }
      const baseline = args.connectorPermissionBaseline.value;
      if (
        !connectorPermissionBaselineMatchesStoredContext(
          args.storedContext,
          baseline,
        )
      ) {
        return await fullRefresh("full_invalid_baseline");
      }
      const resolution = await resolveActiveNetworkPolicyRefreshesFromBaseline(
        args.db,
        scope,
        baseline,
      );
      if (resolution.kind === "incompatible") {
        return await fullRefresh("full_incompatible_baseline");
      }
      if (resolution.kind === "empty") {
        return {
          refreshes: resolution.refreshes,
          path: "baseline_empty" as const,
        };
      }
      return {
        refreshes: resolution.refreshes,
        path: "baseline" as const,
      };
    };
    const selected = await selectRefresh();

    return {
      value: {
        networkPolicies: mergeNetworkPolicyRefreshes(
          storedNetworkPolicies,
          selected.refreshes,
        ),
        networkPolicyRefreshes: networkPolicyRefreshesRecord(
          selected.refreshes,
        ),
      },
      path: selected.path,
    };
  });
}

type StoredResumeSessionWithHistoryRef = Extract<
  NonNullable<StoredExecutionContext["resumeSession"]>,
  { historyRef: { kind: "blob"; hash: string } }
>;

interface CompressedResumeSessionHistoryRepresentation {
  readonly encoding: CompressedSessionHistoryBlobEncoding;
  readonly rawSize: number;
  readonly encodedSize: number;
  readonly objectKey: string;
  readonly downloadSource: SessionHistoryDownloadSource;
}

interface IdentityResumeSessionHistoryRepresentation {
  readonly encoding: typeof SESSION_HISTORY_ENCODING_IDENTITY;
  readonly rawSize: number;
  readonly encodedSize: number;
  readonly downloadSource: SessionHistoryDownloadSource;
}

function hasResumeSessionHistoryRef(
  resumeSession: StoredExecutionContext["resumeSession"],
): resumeSession is StoredResumeSessionWithHistoryRef {
  return resumeSession !== null && "historyRef" in resumeSession;
}

function invalidResumeSessionHistoryError(
  hash: string,
  cause: unknown,
): ResumeSessionHistoryLoadError {
  return new ResumeSessionHistoryLoadError(
    hash,
    RESUME_SESSION_HISTORY_INVALID_ERROR,
    cause,
  );
}

const generateResumeSessionHistoryUrl$ = command(
  async ({ get }, hash: string): Promise<string> => {
    return await get(
      generatePresignedGetUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        resumeSessionHistoryRawBlobKey(hash),
        RESUME_SESSION_HISTORY_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    );
  },
);

const generateResumeSessionHistoryObjectUrl$ = command(
  async ({ get }, objectKey: string): Promise<string> => {
    return await get(
      generatePresignedGetUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        objectKey,
        RESUME_SESSION_HISTORY_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    );
  },
);

const loadCompressedResumeSessionHistoryRepresentation$ = command(
  async (
    _,
    args: {
      readonly db: Db;
      readonly encoding: CompressedSessionHistoryBlobEncoding;
      readonly hash: string;
    },
  ): Promise<CompressedResumeSessionHistoryRepresentation | undefined> => {
    const [blob] = await args.db
      .select({
        rawSize: blobs.rawSize,
        encoding: blobs.encoding,
        encodedSize: blobs.encodedSize,
      })
      .from(blobs)
      .where(eq(blobs.hash, args.hash))
      .limit(1);
    if (!blob) {
      return undefined;
    }
    const encoding = tryNormalizeSessionHistoryBlobEncoding(blob.encoding);
    if (encoding === undefined) {
      throw invalidResumeSessionHistoryError(
        args.hash,
        new Error(`invalid session history blob encoding: ${blob.encoding}`),
      );
    }
    if (encoding !== args.encoding) {
      return undefined;
    }
    if (blob.rawSize <= 0 || blob.encodedSize <= 0) {
      return undefined;
    }

    return {
      encoding,
      rawSize: blob.rawSize,
      encodedSize: blob.encodedSize,
      objectKey: resumeSessionHistoryBlobKey(args.hash, encoding),
      downloadSource: publicS3DownloadSource(),
    };
  },
);

function validateCompressedResumeSessionHistoryRepresentation(
  hash: string,
  representation: CompressedResumeSessionHistoryRepresentation,
): void {
  if (
    representation.rawSize <= 0 ||
    representation.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    representation.encodedSize <= 0 ||
    representation.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    throw invalidResumeSessionHistoryError(
      hash,
      new Error(
        `invalid ${representation.encoding} rawSize: ${representation.rawSize}`,
      ),
    );
  }
}

const loadIdentityResumeSessionHistoryRepresentation$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly hash: string;
    },
  ): Promise<IdentityResumeSessionHistoryRepresentation | undefined> => {
    const [blob] = await args.db
      .select({
        rawSize: blobs.rawSize,
        encoding: blobs.encoding,
        encodedSize: blobs.encodedSize,
      })
      .from(blobs)
      .where(eq(blobs.hash, args.hash))
      .limit(1);
    if (!blob) {
      return undefined;
    }
    const encoding = tryNormalizeSessionHistoryBlobEncoding(blob.encoding);
    if (encoding === undefined) {
      throw invalidResumeSessionHistoryError(
        args.hash,
        new Error(`invalid session history blob encoding: ${blob.encoding}`),
      );
    }
    if (encoding !== SESSION_HISTORY_ENCODING_IDENTITY) {
      return undefined;
    }

    let rawSize = blob.rawSize;
    let encodedSize = blob.encodedSize;
    if (rawSize <= 0 || encodedSize <= 0) {
      const objectKey = resumeSessionHistoryRawBlobKey(args.hash);
      const contentLengthResult = await settle(
        get(
          s3ObjectContentLength(
            env("R2_USER_STORAGES_BUCKET_NAME"),
            objectKey,
            RESUME_SESSION_HISTORY_MAX_BYTES,
          ),
        ),
      );
      if (!contentLengthResult.ok) {
        if (contentLengthResult.error instanceof S3ObjectSizeLimitError) {
          throw invalidResumeSessionHistoryError(
            args.hash,
            contentLengthResult.error,
          );
        }
        throw contentLengthResult.error;
      }
      const contentLength = contentLengthResult.value;
      if (contentLength === undefined || contentLength <= 0) {
        return undefined;
      }
      const [updatedBlob] = await args.db
        .update(blobs)
        .set({
          rawSize: contentLength,
          encoding: SESSION_HISTORY_ENCODING_IDENTITY,
          encodedSize: contentLength,
        })
        .where(and(eq(blobs.hash, args.hash), eq(blobs.rawSize, 0)))
        .returning({
          rawSize: blobs.rawSize,
          encodedSize: blobs.encodedSize,
        });
      rawSize = updatedBlob?.rawSize ?? contentLength;
      encodedSize = updatedBlob?.encodedSize ?? contentLength;
    }
    if (rawSize !== encodedSize) {
      throw invalidResumeSessionHistoryError(
        args.hash,
        new Error(
          `identity session history rawSize must match encodedSize: rawSize=${rawSize}, encodedSize=${encodedSize}`,
        ),
      );
    }

    return {
      encoding: SESSION_HISTORY_ENCODING_IDENTITY,
      rawSize,
      encodedSize,
      downloadSource: publicS3DownloadSource(),
    };
  },
);

async function resolveResumeSessionForClaim(args: {
  readonly resumeSession: StoredExecutionContext["resumeSession"];
  readonly timing: ClaimRouteTimingCollector;
  readonly loadIdentityRepresentation: (
    hash: string,
  ) => Promise<IdentityResumeSessionHistoryRepresentation | undefined>;
  readonly loadCompressedRepresentation: (
    hash: string,
    encoding: CompressedSessionHistoryBlobEncoding,
  ) => Promise<CompressedResumeSessionHistoryRepresentation | undefined>;
  readonly generateResumeSessionHistoryUrl: (hash: string) => Promise<string>;
  readonly generateResumeSessionHistoryObjectUrl: (
    objectKey: string,
  ) => Promise<string>;
}): Promise<ExecutionContext["resumeSession"]> {
  const resumeSession = args.resumeSession;
  if (!hasResumeSessionHistoryRef(resumeSession)) {
    return resumeSession;
  }

  return await args.timing.measure(
    "claim_route_response_resume_session",
    "nested",
    async () => {
      const { sessionId, historyRef } = resumeSession;
      const encoding = historyRef.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
      if (encoding !== SESSION_HISTORY_ENCODING_IDENTITY) {
        const compressedRepresentation =
          await args.loadCompressedRepresentation(historyRef.hash, encoding);
        if (compressedRepresentation === undefined) {
          throw invalidResumeSessionHistoryError(
            historyRef.hash,
            new Error(`${encoding} session history metadata is missing`),
          );
        }
        validateCompressedResumeSessionHistoryRepresentation(
          historyRef.hash,
          compressedRepresentation,
        );
        const url = await args.generateResumeSessionHistoryObjectUrl(
          compressedRepresentation.objectKey,
        );
        return {
          sessionId,
          historyRef: {
            kind: historyRef.kind,
            hash: historyRef.hash,
            url,
            encoding: compressedRepresentation.encoding,
            rawSize: compressedRepresentation.rawSize,
            encodedSize: compressedRepresentation.encodedSize,
            downloadSource: compressedRepresentation.downloadSource,
          },
        };
      }

      const identityRepresentation = await args.loadIdentityRepresentation(
        historyRef.hash,
      );
      if (identityRepresentation === undefined) {
        throw new ResumeSessionHistoryLoadError(
          historyRef.hash,
          RESUME_SESSION_HISTORY_LOAD_ERROR,
          new Error("identity session history metadata is missing"),
        );
      }
      const url = await args.generateResumeSessionHistoryUrl(historyRef.hash);
      return {
        sessionId,
        historyRef: {
          kind: historyRef.kind,
          hash: historyRef.hash,
          url,
          encoding: identityRepresentation.encoding,
          rawSize: identityRepresentation.rawSize,
          encodedSize: identityRepresentation.encodedSize,
          downloadSource: identityRepresentation.downloadSource,
        },
      };
    },
  );
}

async function buildClaimResponseBody(args: {
  readonly db: Db;
  readonly run: ClaimedRun;
  readonly reuseKey: string | null;
  readonly storedContext: StoredExecutionContext;
  readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
  readonly timing: ClaimRouteTimingCollector;
  readonly signal: AbortSignal;
  readonly loadIdentityRepresentation: (
    hash: string,
  ) => Promise<IdentityResumeSessionHistoryRepresentation | undefined>;
  readonly loadCompressedRepresentation: (
    hash: string,
    encoding: CompressedSessionHistoryBlobEncoding,
  ) => Promise<CompressedResumeSessionHistoryRepresentation | undefined>;
  readonly generateResumeSessionHistoryUrl: (hash: string) => Promise<string>;
  readonly generateResumeSessionHistoryObjectUrl: (
    objectKey: string,
  ) => Promise<string>;
}): Promise<ExecutionContext> {
  const secretValues = await secretValuesForRunner(
    args.storedContext,
    args.timing,
  );
  args.signal.throwIfAborted();
  return await args.timing.measure(
    "claim_route_response_assembly",
    "top_level",
    async () => {
      const [resumeSessionResult, refreshedPoliciesResult] =
        await Promise.allSettled([
          resolveResumeSessionForClaim({
            resumeSession: args.storedContext.resumeSession,
            timing: args.timing,
            loadIdentityRepresentation(hash: string) {
              return args.loadIdentityRepresentation(hash);
            },
            loadCompressedRepresentation(
              hash: string,
              encoding: CompressedSessionHistoryBlobEncoding,
            ) {
              return args.loadCompressedRepresentation(hash, encoding);
            },
            generateResumeSessionHistoryUrl:
              args.generateResumeSessionHistoryUrl,
            generateResumeSessionHistoryObjectUrl:
              args.generateResumeSessionHistoryObjectUrl,
          }),
          refreshClaimNetworkPolicies({
            db: args.db,
            run: args.run,
            storedContext: args.storedContext,
            connectorPermissionBaseline: args.connectorPermissionBaseline,
            timing: args.timing,
          }),
        ]);
      if (resumeSessionResult.status === "rejected") {
        const error: unknown = resumeSessionResult.reason;
        throw error;
      }
      const resumeSession = resumeSessionResult.value;
      args.signal.throwIfAborted();
      const sandboxToken = generateSandboxToken(
        args.run.userId,
        args.run.id,
        args.run.orgId,
      );
      if (refreshedPoliciesResult.status === "rejected") {
        const error: unknown = refreshedPoliciesResult.reason;
        throw error;
      }
      const refreshedPolicies = refreshedPoliciesResult.value;
      args.signal.throwIfAborted();
      const {
        connectorPermissionBaseline: _connectorPermissionBaseline,
        secretValueEnvironmentKeys: _secretValueEnvironmentKeys,
        storageMounts: _storedStorageMounts,
        ...runnerStoredContext
      } = args.storedContext;
      return {
        ...runnerStoredContext,
        runId: args.run.id,
        reuseKey: args.reuseKey,
        prompt: args.run.prompt,
        appendSystemPrompt: args.run.appendSystemPrompt,
        agentComposeVersionId: args.run.agentComposeVersionId,
        vars: mergeClaimVars({
          runVars: (args.run.vars as Record<string, string> | null) ?? null,
          connectorVars: args.storedContext.vars,
        }),
        storageManifest: {
          storageMounts: args.storedContext.storageMounts.map((storedMount) => {
            const { orgId: _orgId, userId: _userId, ...mount } = storedMount;
            return mount;
          }),
        },
        resumeSession,
        sandboxToken,
        secretValues,
        networkPolicies: refreshedPolicies.networkPolicies,
        networkPolicyRefreshes: refreshedPolicies.networkPolicyRefreshes,
      };
    },
  );
}

const buildClaimResponseBodyForClaim$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly run: ClaimedRun;
      readonly reuseKey: string | null;
      readonly storedContext: StoredExecutionContext;
      readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
      readonly timing: ClaimRouteTimingCollector;
      readonly signal: AbortSignal;
    },
  ): Promise<ExecutionContext> => {
    return await buildClaimResponseBody({
      db: args.db,
      run: args.run,
      reuseKey: args.reuseKey,
      storedContext: args.storedContext,
      connectorPermissionBaseline: args.connectorPermissionBaseline,
      timing: args.timing,
      signal: args.signal,
      loadIdentityRepresentation(hash: string) {
        return set(loadIdentityResumeSessionHistoryRepresentation$, {
          db: args.db,
          hash,
        });
      },
      loadCompressedRepresentation(
        hash: string,
        encoding: CompressedSessionHistoryBlobEncoding,
      ) {
        return set(loadCompressedResumeSessionHistoryRepresentation$, {
          db: args.db,
          encoding,
          hash,
        });
      },
      generateResumeSessionHistoryUrl(hash: string) {
        return set(generateResumeSessionHistoryUrl$, hash);
      },
      generateResumeSessionHistoryObjectUrl(objectKey: string) {
        return set(generateResumeSessionHistoryObjectUrl$, objectKey);
      },
    });
  },
);

interface ClaimTimingTelemetry {
  readonly discoverySource?: string;
  readonly jobDiscoveredToClaimRequestMs?: number;
  readonly localAdmissionToClaimRequestMs?: number;
  readonly directCandidateNotificationToEnqueueMs?: number;
  readonly directCandidateInboxWaitMs?: number;
  readonly providerDiscoveryToMainLoopMs?: number;
  readonly mainLoopToLocalAdmissionMs?: number;
  readonly pollDueToJobDiscoveredMs?: number;
  readonly pollHttpRequestMs?: number;
  readonly pollReason?: string;
}

function scheduleSuccessfulClaimSideEffects(args: {
  readonly jobWithRun: ClaimableJob;
  readonly authType: RunnerAuthContext["type"];
  readonly storedContext: StoredExecutionContext;
  readonly claimRequestStartedAtMs: number;
  readonly claimResult: ClaimedTransitionResult;
  readonly telemetry: ClaimTimingTelemetry | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}): void {
  const { job, run } = args.jobWithRun;
  const queueCreatedAtMs = job.createdAt.getTime();
  scheduleClaimSucceededSideEffects({
    runId: run.id,
    userId: run.userId,
    runnerGroup: job.runnerGroup,
    profile: job.profile,
    authType: args.authType,
    apiToRunnerQueueMs: elapsedSinceApiStartMs(
      args.storedContext.apiStartTime,
      queueCreatedAtMs,
    ),
    runnerQueueToClaimRequestMs: Math.max(
      0,
      args.claimRequestStartedAtMs - queueCreatedAtMs,
    ),
    apiToClaimRequestMs: elapsedSinceApiStartMs(
      args.storedContext.apiStartTime,
      args.claimRequestStartedAtMs,
    ),
    apiToClaimMs: elapsedSinceApiStartMs(
      args.storedContext.apiStartTime,
      args.claimResult.claimedAt.getTime(),
    ),
    claimRequestToRunningMs: Math.max(
      0,
      args.claimResult.claimedAt.getTime() - args.claimRequestStartedAtMs,
    ),
    jobDiscoveredToClaimRequestMs:
      args.telemetry?.jobDiscoveredToClaimRequestMs,
    localAdmissionToClaimRequestMs:
      args.telemetry?.localAdmissionToClaimRequestMs,
    directCandidateNotificationToEnqueueMs:
      args.telemetry?.directCandidateNotificationToEnqueueMs,
    directCandidateInboxWaitMs: args.telemetry?.directCandidateInboxWaitMs,
    providerDiscoveryToMainLoopMs:
      args.telemetry?.providerDiscoveryToMainLoopMs,
    mainLoopToLocalAdmissionMs: args.telemetry?.mainLoopToLocalAdmissionMs,
    discoverySource: args.telemetry?.discoverySource,
    pollDueToJobDiscoveredMs: args.telemetry?.pollDueToJobDiscoveredMs,
    pollHttpRequestMs: args.telemetry?.pollHttpRequestMs,
    pollReason: args.telemetry?.pollReason,
    claimRouteTiming: args.claimRouteTiming,
  });
}

function scheduleClaimSucceededSideEffects(args: {
  readonly runId: string;
  readonly userId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly apiToRunnerQueueMs: number | undefined;
  readonly runnerQueueToClaimRequestMs: number;
  readonly apiToClaimRequestMs: number | undefined;
  readonly apiToClaimMs: number | undefined;
  readonly claimRequestToRunningMs: number;
  readonly jobDiscoveredToClaimRequestMs: number | undefined;
  readonly localAdmissionToClaimRequestMs: number | undefined;
  readonly directCandidateNotificationToEnqueueMs: number | undefined;
  readonly directCandidateInboxWaitMs: number | undefined;
  readonly providerDiscoveryToMainLoopMs: number | undefined;
  readonly mainLoopToLocalAdmissionMs: number | undefined;
  readonly discoverySource: string | undefined;
  readonly pollDueToJobDiscoveredMs: number | undefined;
  readonly pollHttpRequestMs: number | undefined;
  readonly pollReason: string | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}): void {
  waitUntil(
    publishRunChangedForUserSafely(args.userId, args.runId, {
      status: "running",
    }),
  );

  waitUntil(
    tapError(recordClaimTimingMetrics(args), (error) => {
      L.warn("recordSandboxOperation failed", { runId: args.runId, error });
    }),
  );
}

interface ClaimTimingMetricArgs {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly apiToRunnerQueueMs: number | undefined;
  readonly runnerQueueToClaimRequestMs: number;
  readonly apiToClaimRequestMs: number | undefined;
  readonly apiToClaimMs: number | undefined;
  readonly claimRequestToRunningMs: number;
  readonly jobDiscoveredToClaimRequestMs: number | undefined;
  readonly localAdmissionToClaimRequestMs: number | undefined;
  readonly directCandidateNotificationToEnqueueMs: number | undefined;
  readonly directCandidateInboxWaitMs: number | undefined;
  readonly providerDiscoveryToMainLoopMs: number | undefined;
  readonly mainLoopToLocalAdmissionMs: number | undefined;
  readonly discoverySource: string | undefined;
  readonly pollDueToJobDiscoveredMs: number | undefined;
  readonly pollHttpRequestMs: number | undefined;
  readonly pollReason: string | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}

type ClaimTimingMetricValueKey =
  | "apiToRunnerQueueMs"
  | "runnerQueueToClaimRequestMs"
  | "apiToClaimRequestMs"
  | "apiToClaimMs"
  | "claimRequestToRunningMs"
  | "jobDiscoveredToClaimRequestMs"
  | "localAdmissionToClaimRequestMs"
  | "directCandidateNotificationToEnqueueMs"
  | "directCandidateInboxWaitMs"
  | "providerDiscoveryToMainLoopMs"
  | "mainLoopToLocalAdmissionMs"
  | "pollDueToJobDiscoveredMs"
  | "pollHttpRequestMs";

const CLAIM_TIMING_METRIC_FIELDS = [
  { actionType: "api_to_runner_queue", valueKey: "apiToRunnerQueueMs" },
  {
    actionType: "runner_queue_to_claim_request",
    valueKey: "runnerQueueToClaimRequestMs",
  },
  { actionType: "api_to_claim_request", valueKey: "apiToClaimRequestMs" },
  { actionType: "api_to_claim", valueKey: "apiToClaimMs" },
  {
    actionType: "claim_request_to_running",
    valueKey: "claimRequestToRunningMs",
  },
  {
    actionType: "job_discovered_to_claim_request",
    valueKey: "jobDiscoveredToClaimRequestMs",
  },
  {
    actionType: "local_admission_to_claim_request",
    valueKey: "localAdmissionToClaimRequestMs",
  },
  {
    actionType: "direct_candidate_notification_to_enqueue",
    valueKey: "directCandidateNotificationToEnqueueMs",
  },
  {
    actionType: "direct_candidate_inbox_wait",
    valueKey: "directCandidateInboxWaitMs",
  },
  {
    actionType: "provider_discovery_to_main_loop",
    valueKey: "providerDiscoveryToMainLoopMs",
  },
  {
    actionType: "main_loop_to_local_admission",
    valueKey: "mainLoopToLocalAdmissionMs",
  },
  {
    actionType: "runner_poll_due_to_job_discovered",
    valueKey: "pollDueToJobDiscoveredMs",
  },
  { actionType: "runner_poll_http_request", valueKey: "pollHttpRequestMs" },
] as const satisfies readonly {
  readonly actionType: string;
  readonly valueKey: ClaimTimingMetricValueKey;
}[];

async function recordClaimTimingMetrics(
  args: ClaimTimingMetricArgs,
): Promise<void> {
  await Promise.resolve();
  const dimensions = claimTimingDimensions(args);
  recordSandboxOperations(claimTimingOperations(args, dimensions));
  args.claimRouteTiming.flush({
    runId: args.runId,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    authType: args.authType,
    discoverySource: args.discoverySource,
    pollReason: args.pollReason,
  });
}

function claimTimingDimensions(
  args: ClaimTimingMetricArgs,
): Record<string, string> {
  const dimensions: Record<string, string> = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    auth_type: args.authType,
  };
  if (args.discoverySource) {
    dimensions.discovery_source = args.discoverySource;
  }
  if (args.pollReason) {
    dimensions.poll_reason = args.pollReason;
  }
  return dimensions;
}

function claimTimingOperations(
  args: ClaimTimingMetricArgs,
  dimensions: Record<string, string>,
): SandboxOperationAttrs[] {
  return CLAIM_TIMING_METRIC_FIELDS.map(({ actionType, valueKey }) => {
    return claimTimingOperation(
      args.runId,
      actionType,
      args[valueKey],
      dimensions,
    );
  }).filter((operation): operation is SandboxOperationAttrs => {
    return operation !== undefined;
  });
}

function claimTimingOperation(
  runId: string,
  actionType: string,
  durationMs: number | undefined,
  dimensions: Record<string, string>,
): SandboxOperationAttrs | undefined {
  if (durationMs === undefined) {
    return undefined;
  }
  return {
    sandboxType: "runner",
    actionType,
    durationMs,
    success: true,
    runId,
    dimensions,
  };
}

const scheduleClaimFailedSideEffects$ = command(
  ({ set }, args: ClaimFailedSideEffectArgs): void => {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      publishRunChangedForUserSafely(args.userId, args.runId, {
        status: "failed",
      }),
    );
    waitUntil(
      tapError(
        set(
          dispatchCompleteSideEffects$,
          {
            kind: "terminal",
            runId: args.runId,
            orgId: args.orgId,
            status: "failed",
            error: args.error,
          },
          backgroundSignal,
        ),
        (error) => {
          L.error("dispatchCompleteSideEffects failed", {
            runId: args.runId,
            error,
          });
        },
      ),
    );
  },
);

async function failClaimForResumeSessionHistoryLoad(args: {
  readonly db: Db;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly hash: string;
  readonly errorMessage: string;
  readonly cause: unknown;
  readonly signal: AbortSignal;
  readonly scheduleFailedSideEffects: (args: ClaimFailedSideEffectArgs) => void;
}) {
  L.warn("session history R2 object could not be loaded during claim", {
    runId: args.runId,
    hash: args.hash,
    errorMessage: args.errorMessage,
    error: args.cause,
  });
  const poisonResult = await failPoisonQueuedJob(
    args.db,
    args.runId,
    args.errorMessage,
    args.signal,
  );
  if (poisonResult.status !== "failed") {
    return poisonJobErrorResponse(poisonResult);
  }
  args.scheduleFailedSideEffects({
    runId: args.runId,
    userId: args.userId,
    orgId: args.orgId,
    error: args.errorMessage,
  });
  return badRequestMessage(args.errorMessage);
}

async function failClaimForInvalidStoredExecutionContext(args: {
  readonly db: Db;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly signal: AbortSignal;
  readonly scheduleFailedSideEffects: (args: ClaimFailedSideEffectArgs) => void;
}) {
  const poisonResult = await failPoisonQueuedJob(
    args.db,
    args.runId,
    INVALID_EXECUTION_CONTEXT_ERROR,
    args.signal,
  );
  if (poisonResult.status !== "failed") {
    return poisonJobErrorResponse(poisonResult);
  }
  args.scheduleFailedSideEffects({
    runId: args.runId,
    userId: args.userId,
    orgId: args.orgId,
    error: INVALID_EXECUTION_CONTEXT_ERROR,
  });
  return badRequestMessage("Job missing execution context");
}

async function claimResponseBuildErrorResponse(args: {
  readonly db: Db;
  readonly run: ClaimedRun;
  readonly runId: string;
  readonly error: unknown;
  readonly signal: AbortSignal;
  readonly scheduleFailedSideEffects: (args: ClaimFailedSideEffectArgs) => void;
}) {
  if (!isResumeSessionHistoryLoadError(args.error)) {
    throw args.error;
  }
  return await failClaimForResumeSessionHistoryLoad({
    db: args.db,
    runId: args.runId,
    hash: args.error.hash,
    userId: args.run.userId,
    orgId: args.run.orgId,
    errorMessage: args.error.message,
    cause: args.error.cause,
    signal: args.signal,
    scheduleFailedSideEffects: args.scheduleFailedSideEffects,
  });
}

const claimAuthorizedJob$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly authType: RunnerAuthContext["type"];
      readonly jobWithRun: ClaimableJob;
      readonly cancellationRecoverySupported: boolean;
      readonly telemetry: ClaimTimingTelemetry | undefined;
      readonly claimRequestStartedAtMs: number;
      readonly claimRouteTiming: ClaimRouteTimingCollector;
      readonly signal: AbortSignal;
    },
  ) => {
    const { db, runId, jobWithRun, claimRouteTiming, signal } = args;
    const run = jobWithRun.run;

    const contextParseStartedAt = now();
    const storedContextResult =
      compatibleStoredExecutionContextSchema.safeParse(
        jobWithRun.job.executionContext,
      );
    claimRouteTiming.recordElapsed(
      "claim_route_context_parse",
      "top_level",
      contextParseStartedAt,
    );
    signal.throwIfAborted();
    if (!storedContextResult.success) {
      warnInvalidStoredExecutionContext(
        runId,
        storedContextResult.error.issues,
      );
      return await failClaimForInvalidStoredExecutionContext({
        db,
        runId,
        userId: run.userId,
        orgId: run.orgId,
        signal,
        scheduleFailedSideEffects(failedArgs) {
          set(scheduleClaimFailedSideEffects$, failedArgs);
        },
      });
    }
    const { context: storedContext, connectorPermissionBaseline } =
      decodeCompatibleStoredExecutionContext(storedContextResult.data);

    const responseBodyResult = await settle(
      set(buildClaimResponseBodyForClaim$, {
        db,
        run,
        reuseKey: jobWithRun.job.reuseKey,
        storedContext,
        connectorPermissionBaseline,
        timing: claimRouteTiming,
        signal,
      }),
      signal,
    );
    if (!responseBodyResult.ok) {
      return await claimResponseBuildErrorResponse({
        db,
        run,
        runId,
        error: responseBodyResult.error,
        signal,
        scheduleFailedSideEffects(failedArgs) {
          set(scheduleClaimFailedSideEffects$, failedArgs);
        },
      });
    }
    signal.throwIfAborted();

    const claimResult = await claimRouteTiming.measure(
      "claim_route_transition_running",
      "top_level",
      async () => {
        return await transitionClaimedJobToRunning(
          db,
          runId,
          args.cancellationRecoverySupported,
          signal,
          claimRouteTiming,
        );
      },
    );
    signal.throwIfAborted();
    if (claimResult.status !== "claimed") {
      return claimTransitionErrorResponse(claimResult);
    }

    scheduleSuccessfulClaimSideEffects({
      jobWithRun,
      authType: args.authType,
      storedContext,
      claimRequestStartedAtMs: args.claimRequestStartedAtMs,
      claimResult,
      telemetry: args.telemetry,
      claimRouteTiming,
    });

    return { status: 200 as const, body: responseBodyResult.value };
  },
);

const claimInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const claimRequestStartedAtMs = now();
  const claimRouteTiming = new ClaimRouteTimingCollector();
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedNotAuthenticated;
  }

  const body = await get(claimBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const runId = get(pathParamsOf(runnersJobClaimContract.claim)).id;
  const db = set(writeDb$);
  claimRouteTiming.recordElapsed(
    "claim_route_request_prepare",
    "top_level",
    claimRequestStartedAtMs,
  );

  const lookupAuthorizationStartedAt = now();
  const jobWithRun = await getClaimableJob(db, runId, signal);
  if (!isClaimableJob(jobWithRun)) {
    return jobWithRun;
  }
  const authError = claimAuthorizationError(auth, jobWithRun);
  claimRouteTiming.recordElapsed(
    "claim_route_lookup_authorization",
    "top_level",
    lookupAuthorizationStartedAt,
  );
  if (authError) {
    return authError;
  }

  return await set(claimAuthorizedJob$, {
    db,
    runId,
    authType: auth.type,
    jobWithRun,
    cancellationRecoverySupported:
      body.data.capabilities?.includes(
        RUNNER_CANCELLATION_RECOVERY_CAPABILITY,
      ) === true,
    telemetry: body.data.telemetry,
    claimRequestStartedAtMs,
    claimRouteTiming,
    signal,
  });
});

const runnerRealtimeTokenBody$ = bodyResultOf(
  runnerRealtimeTokenContract.create,
);

const networkPolicyRefreshInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(networkPolicyRefreshBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const runId = get(
      pathParamsOf(runnersNetworkPolicyRefreshContract.refresh),
    ).runId;
    const db = set(writeDb$);
    const run = await getRunNetworkPolicyScope(db, runId, signal);
    if (!run) {
      return notFound("Run not found");
    }

    const authError = runnerRunAuthorizationError(auth, run);
    if (run.status !== "running") {
      if (authError || !isTerminalRunStatus(run.status)) {
        return notFound("Run not found");
      }
      return {
        status: 409 as const,
        body: {
          error: {
            code: NETWORK_POLICY_REFRESH_RUN_TERMINAL_ERROR_CODE,
            message: "Run is terminal",
          },
        },
      };
    }
    if (authError) {
      return authError;
    }

    const { connectorSlugs } = body.data;
    const refreshes = await resolveActiveNetworkPolicyRefreshes(
      db,
      {
        orgId: run.orgId,
        userId: run.userId,
        agentId: run.agentId,
      },
      connectorSlugs,
    );
    signal.throwIfAborted();
    if (refreshes.length === 0) {
      return notFound(`Connectors not found: ${connectorSlugs.join(", ")}`);
    }

    return {
      status: 200 as const,
      body: {
        refreshes: refreshes.map((refresh) => {
          return {
            connectorSlug: refresh.connectorSlug,
            networkPolicy: refresh.networkPolicy,
            nextRefreshAt: refresh.nextRefreshAt,
          };
        }),
      },
    };
  },
);

const runnerRealtimeTokenInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(runnerRealtimeTokenBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const { group } = body.data;
    if (auth.type === "official-runner") {
      if (!isOfficialRunnerGroup(group)) {
        return forbidden("Official runners can only subscribe to vm0/* groups");
      }
    } else if (!isOfficialRunnerGroup(group)) {
      return forbidden("Only vm0/* runner groups are supported");
    }

    const tokenRequest = await createRunnerGroupRealtimeToken(group);
    signal.throwIfAborted();

    return { status: 200 as const, body: tokenRequest };
  },
);

const builtinFirewallsResolveInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(builtinFirewallsResolveBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const catalog = await loadConnectorRunnerFirewallCatalog(() => {
      return get(db$);
    });
    signal.throwIfAborted();
    const names =
      body.data.names === undefined ? undefined : [...new Set(body.data.names)];
    const missingNames = (names ?? []).filter((name) => {
      return !catalog.has(name);
    });
    if (missingNames.length > 0) {
      return badRequestMessage(
        `Unknown builtin firewall: ${missingNames.join(", ")}`,
      );
    }
    const firewalls = await catalog.load(names);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        catalogDigest: catalog.catalogDigest,
        catalogVersion: catalog.catalogVersion,
        firewalls,
      },
    };
  },
);

export const runnersRoutes: readonly RouteEntry[] = [
  {
    route: runnersHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: runnersPollContract.poll,
    handler: pollInner$,
  },
  {
    route: runnersJobClaimContract.claim,
    handler: claimInner$,
  },
  {
    route: runnersNetworkPolicyRefreshContract.refresh,
    handler: networkPolicyRefreshInner$,
  },
  {
    route: runnersBuiltinFirewallsResolveContract.resolve,
    handler: builtinFirewallsResolveInner$,
  },
  {
    route: runnerRealtimeTokenContract.create,
    handler: runnerRealtimeTokenInner$,
  },
];
