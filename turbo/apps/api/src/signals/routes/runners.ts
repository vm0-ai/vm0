import { command } from "ccstate";
import {
  elapsedSinceApiStartMs,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  runnersNetworkPolicyRefreshContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
  storedExecutionContextSchema,
  type ExecutionContext,
  type HeldSessionState,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { blobs } from "@vm0/db/schema/blob";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import { and, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";

import { runnerAuth$, type RunnerAuthContext } from "../auth/runner-auth";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  generatePresignedGetUrl,
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
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { generateSandboxToken } from "../auth/tokens";
import { decryptPersistentSecretsMap } from "../services/crypto.utils";
import { dispatchCompleteSideEffects$ } from "../services/agent-webhook-complete.service";
import {
  networkPolicyRefreshesRecord,
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshConnectorRefs,
  resolveActiveNetworkPolicyRefreshes,
} from "../services/zero-user-permission-grants.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  resumeSessionHistoryBlobKey,
  resumeSessionHistoryRawBlobKey,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  tryNormalizeSessionHistoryBlobEncoding,
} from "../services/session-history-blobs";
import {
  runnerSessionAffinityLookupError,
  runnerSessionAffinityProtection,
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
type ClaimRouteTimingActionType =
  | "claim_route_request_prepare"
  | "claim_route_lookup_authorization"
  | "claim_route_context_parse"
  | "claim_route_feature_switch_context"
  | "claim_route_secret_materialization"
  | "claim_route_response_assembly"
  | "claim_route_transition_running"
  | "claim_route_transition_lock_run"
  | "claim_route_transition_lock_queue_job"
  | "claim_route_transition_update_run"
  | "claim_route_transition_delete_queue_job";

interface ClaimRouteTimingRecord {
  readonly actionType: ClaimRouteTimingActionType;
  readonly spanKind: ClaimRouteTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
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
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
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
  // Stage 1 wire compatibility: accept legacy heartbeat fields until #20162.
  const admittableProfiles =
    body.data.admittableProfiles ??
    body.data.availableProfiles ??
    body.data.profiles;
  if (admittableProfiles === undefined) {
    return badRequestMessage("admittableProfiles is required");
  }
  // Stage 1 compatibility: remove the legacy static profile write in #20163.
  const staticProfiles = body.data.profiles ?? [];
  const currentDate = nowDate();
  const db = set(writeDb$);
  await db
    .insert(runnerState)
    .values({
      runnerId: body.data.runnerId,
      runnerName: body.data.runnerName,
      runnerGroup: body.data.group,
      profiles: staticProfiles,
      totalVcpu: body.data.totalVcpu,
      totalMemoryMb: body.data.totalMemoryMb,
      maxConcurrent: body.data.maxConcurrent,
      allocatedVcpu: body.data.allocatedVcpu,
      allocatedMemoryMb: body.data.allocatedMemoryMb,
      runningCount: body.data.runningCount,
      availableProfiles: admittableProfiles,
      heldSessionStates,
      mode: body.data.mode,
      lastSeenAt: currentDate,
    })
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: {
        runnerName: body.data.runnerName,
        runnerGroup: body.data.group,
        profiles: staticProfiles,
        totalVcpu: body.data.totalVcpu,
        totalMemoryMb: body.data.totalMemoryMb,
        maxConcurrent: body.data.maxConcurrent,
        allocatedVcpu: body.data.allocatedVcpu,
        allocatedMemoryMb: body.data.allocatedMemoryMb,
        runningCount: body.data.runningCount,
        availableProfiles: admittableProfiles,
        heldSessionStates,
        mode: body.data.mode,
        lastSeenAt: currentDate,
      },
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

  const { group } = body.data;
  // Stage 1 wire compatibility: accept legacy poll profiles until #20162.
  const supportedProfiles = body.data.supportedProfiles ?? body.data.profiles;
  if (supportedProfiles === undefined || supportedProfiles.length === 0) {
    return badRequestMessage("supportedProfiles is required");
  }
  const whereConditions: SQL<unknown>[] = [
    eq(runnerJobQueue.runnerGroup, group),
    isNull(runnerJobQueue.claimedAt),
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
  const db = set(writeDb$);
  const pendingJobLookupStartedAtMs = now();
  const [pendingJob] = await db
    .select({
      runId: runnerJobQueue.runId,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      agentComposeVersionId: agentRuns.agentComposeVersionId,
      vars: agentRuns.vars,
      resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      profile: runnerJobQueue.profile,
      cliAgentSessionId: runnerJobQueue.cliAgentSessionId,
      createdAt: runnerJobQueue.createdAt,
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .where(and(...whereConditions))
    .orderBy(runnerJobQueue.createdAt)
    .limit(1);
  signal.throwIfAborted();
  const pendingJobLookupFinishedAtMs = now();

  if (!pendingJob) {
    return { status: 200 as const, body: { job: null } };
  }

  const affinityResult = await settle(
    runnerSessionAffinityProtection({
      db,
      runnerGroup: group,
      profile: pendingJob.profile,
      cliAgentSessionId: pendingJob.cliAgentSessionId,
      createdAt: pendingJob.createdAt,
      currentDate: nowDate(),
    }),
    signal,
  );
  signal.throwIfAborted();
  const affinity = affinityResult.ok
    ? affinityResult.value
    : runnerSessionAffinityLookupError();
  if (!affinityResult.ok) {
    L.warn("Failed to resolve runner session affinity for poll response", {
      runId: pendingJob.runId,
      runnerGroup: group,
      profile: pendingJob.profile,
      error: affinityResult.error,
    });
  }
  const pollResponseAtMs = now();
  recordPollTimingMetrics({
    runId: pendingJob.runId,
    runnerGroup: group,
    profile: pendingJob.profile,
    authType: auth.type,
    pollReason: body.data.telemetry?.pollReason,
    sessionAffinity: affinity.status,
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
        checkpointId: pendingJob.resumedFromCheckpointId ?? null,
        experimentalProfile: pendingJob.profile,
        cliAgentSessionId: pendingJob.cliAgentSessionId,
        affinityProtectedUntil: affinity.protectedUntil?.toISOString() ?? null,
      },
    },
  };
});

const claimBody$ = bodyResultOf(runnersJobClaimContract.claim);
const networkPolicyRefreshBody$ = bodyResultOf(
  runnersNetworkPolicyRefreshContract.refresh,
);

interface ClaimableJob {
  readonly job: typeof runnerJobQueue.$inferSelect;
  readonly run: ClaimedRun;
}

interface ClaimedRun {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly agentComposeVersionId: string | null;
  readonly agentId: string | null;
  readonly vars: unknown;
  readonly resumedFromCheckpointId: string | null;
}

interface ActiveRunNetworkPolicyScope {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

type ClaimLookupResult =
  | ClaimableJob
  | ReturnType<typeof conflict>
  | ReturnType<typeof notFound>;

function isClaimableJob(value: ClaimLookupResult): value is ClaimableJob {
  return "job" in value;
}

async function getActiveRunNetworkPolicyScope(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<ActiveRunNetworkPolicyScope | undefined> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      agentId: agentComposeVersions.composeId,
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
    .limit(1);
  signal.throwIfAborted();
  return row;
}

function runnerRunAuthorizationError(
  auth: RunnerAuthContext,
  run: Pick<ActiveRunNetworkPolicyScope, "userId">,
) {
  if (auth.type === "official-runner") {
    return null;
  }
  return run.userId === auth.userId
    ? null
    : forbidden("Run does not belong to user");
}

async function getClaimableJob(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<ClaimLookupResult> {
  const [jobWithRun] = await db
    .select({
      job: runnerJobQueue,
      run: {
        id: agentRuns.id,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        agentId: agentComposeVersions.composeId,
        vars: agentRuns.vars,
        resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      },
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .where(
      and(
        eq(runnerJobQueue.runId, runId),
        isNull(runnerJobQueue.claimedAt),
        gt(runnerJobQueue.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (jobWithRun) {
    return jobWithRun;
  }

  const [existingJob] = await db
    .select({
      runId: runnerJobQueue.runId,
      isExpired: sql<boolean>`${runnerJobQueue.expiresAt} <= now()`,
    })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();

  if (!existingJob || existingJob.isExpired) {
    return notFound("Job not found in queue");
  }
  return conflict("Job already claimed");
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
  | { readonly status: "conflict" }
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

interface LockedClaimRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
}

function claimTransitionErrorResponse(result: FailedClaimTransitionResult) {
  if (result.status === "conflict") {
    return conflict("Job was claimed by another runner");
  }
  if (result.status === "job-not-found") {
    return notFound("Job not found in queue");
  }
  return notFound("Run not found");
}

interface LockedRunnerJobRow extends Record<string, unknown> {
  readonly runId: string;
  readonly claimedAt: Date | null;
  readonly isExpired: boolean;
}

async function lockClaimRun(
  db: Pick<Db, "execute">,
  runId: string,
): Promise<LockedClaimRunRow | undefined> {
  const rows = await db.execute<LockedClaimRunRow>(sql`
    SELECT
      ${agentRuns.id} AS "id",
      ${agentRuns.status} AS "status"
    FROM ${agentRuns}
    WHERE ${agentRuns.id} = ${runId}
    FOR UPDATE
  `);
  return rows.rows[0];
}

async function lockRunnerJob(
  db: Pick<Db, "execute">,
  runId: string,
): Promise<LockedRunnerJobRow | undefined> {
  const rows = await db.execute<LockedRunnerJobRow>(sql`
    SELECT
      ${runnerJobQueue.runId} AS "runId",
      ${runnerJobQueue.claimedAt} AS "claimedAt",
      ${runnerJobQueue.expiresAt} <= now() AS "isExpired"
    FROM ${runnerJobQueue}
    WHERE ${runnerJobQueue.runId} = ${runId}
    FOR UPDATE
  `);
  return rows.rows[0];
}

async function transitionClaimedJobToRunning(
  db: Db,
  runId: string,
  signal: AbortSignal,
  timing: ClaimRouteTimingCollector,
): Promise<ClaimTransitionResult> {
  return await db.transaction(async (tx) => {
    const run = await timing.measure(
      "claim_route_transition_lock_run",
      "nested",
      async () => {
        return await lockClaimRun(tx, runId);
      },
    );
    signal.throwIfAborted();
    if (!run) {
      return { status: "run-not-found" };
    }
    if (run.status !== "pending") {
      await timing.measure(
        "claim_route_transition_delete_queue_job",
        "nested",
        async () => {
          await tx
            .delete(runnerJobQueue)
            .where(eq(runnerJobQueue.runId, runId));
        },
      );
      signal.throwIfAborted();
      return { status: "run-not-found" };
    }

    const job = await timing.measure(
      "claim_route_transition_lock_queue_job",
      "nested",
      async () => {
        return await lockRunnerJob(tx, runId);
      },
    );
    signal.throwIfAborted();
    if (!job || job.isExpired) {
      return { status: "job-not-found" };
    }
    if (job.claimedAt) {
      return { status: "conflict" };
    }

    const claimedAt = nowDate();
    const [updatedRun] = await timing.measure(
      "claim_route_transition_update_run",
      "nested",
      async () => {
        return await tx
          .update(agentRuns)
          .set({
            status: "running",
            startedAt: claimedAt,
            lastHeartbeatAt: claimedAt,
          })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "pending")))
          .returning({ id: agentRuns.id });
      },
    );
    signal.throwIfAborted();
    if (!updatedRun) {
      throw new Error("Locked pending run was not claimed");
    }

    await timing.measure(
      "claim_route_transition_delete_queue_job",
      "nested",
      async () => {
        await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
      },
    );
    signal.throwIfAborted();

    return { status: "claimed" as const, claimedAt };
  });
}

type PoisonJobResult =
  | { readonly status: "failed" }
  | { readonly status: "conflict" }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };
type FailedPoisonJobResult = Exclude<
  PoisonJobResult,
  { readonly status: "failed" }
>;

function poisonJobErrorResponse(result: FailedPoisonJobResult) {
  if (result.status === "conflict") {
    return conflict("Job was claimed by another runner");
  }
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
    if (job.claimedAt) {
      return { status: "conflict" };
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

async function secretValuesForRunner(
  storedContext: StoredExecutionContext,
  featureSwitchContext: FeatureSwitchContext,
): Promise<string[] | null> {
  const secretsMap = await decryptPersistentSecretsMap(
    storedContext.encryptedSecrets,
    featureSwitchContext,
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
}

async function refreshClaimNetworkPolicies(args: {
  readonly db: Db;
  readonly run: ClaimedRun;
  readonly storedContext: StoredExecutionContext;
}): Promise<
  Pick<StoredExecutionContext, "networkPolicies" | "networkPolicyRefreshes">
> {
  const connectorRefs = networkPolicyRefreshConnectorRefs(
    Object.keys(args.storedContext.networkPolicies ?? {}),
  );
  if (connectorRefs.length === 0) {
    return {
      networkPolicies: args.storedContext.networkPolicies,
      networkPolicyRefreshes: undefined,
    };
  }

  if (!args.run.agentId) {
    return {
      networkPolicies: args.storedContext.networkPolicies,
      networkPolicyRefreshes: undefined,
    };
  }

  const refreshes = await resolveActiveNetworkPolicyRefreshes(
    args.db,
    {
      orgId: args.run.orgId,
      userId: args.run.userId,
      agentId: args.run.agentId,
    },
    connectorRefs,
  );
  return {
    networkPolicies: mergeNetworkPolicyRefreshes(
      args.storedContext.networkPolicies,
      refreshes,
    ),
    networkPolicyRefreshes: networkPolicyRefreshesRecord(refreshes),
  };
}

type StoredResumeSessionWithHistoryRef = Extract<
  NonNullable<StoredExecutionContext["resumeSession"]>,
  { historyRef: { kind: "blob"; hash: string } }
>;

interface GzipResumeSessionHistoryRepresentation {
  readonly encoding: typeof SESSION_HISTORY_ENCODING_GZIP;
  readonly rawSize: number;
  readonly encodedSize: number;
  readonly objectKey: string;
}

interface IdentityResumeSessionHistoryRepresentation {
  readonly encoding: typeof SESSION_HISTORY_ENCODING_IDENTITY;
  readonly rawSize: number;
  readonly encodedSize: number;
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

const loadGzipResumeSessionHistoryRepresentation$ = command(
  async (
    _,
    args: {
      readonly db: Db;
      readonly hash: string;
    },
  ): Promise<GzipResumeSessionHistoryRepresentation | undefined> => {
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
    if (encoding !== SESSION_HISTORY_ENCODING_GZIP) {
      return undefined;
    }
    if (blob.rawSize <= 0 || blob.encodedSize <= 0) {
      return undefined;
    }

    return {
      encoding: SESSION_HISTORY_ENCODING_GZIP,
      rawSize: blob.rawSize,
      encodedSize: blob.encodedSize,
      objectKey: resumeSessionHistoryBlobKey(args.hash, encoding),
    };
  },
);

function validateGzipResumeSessionHistoryRepresentation(
  hash: string,
  representation: GzipResumeSessionHistoryRepresentation,
): void {
  if (
    representation.rawSize <= 0 ||
    representation.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    representation.encodedSize <= 0 ||
    representation.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    throw invalidResumeSessionHistoryError(
      hash,
      new Error(`invalid gzip rawSize: ${representation.rawSize}`),
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
    };
  },
);

async function resolveResumeSessionForClaim(args: {
  readonly resumeSession: StoredExecutionContext["resumeSession"];
  readonly loadIdentityRepresentation: (
    hash: string,
  ) => Promise<IdentityResumeSessionHistoryRepresentation | undefined>;
  readonly loadGzipRepresentation: (
    hash: string,
  ) => Promise<GzipResumeSessionHistoryRepresentation | undefined>;
  readonly generateResumeSessionHistoryUrl: (hash: string) => Promise<string>;
  readonly generateResumeSessionHistoryObjectUrl: (
    objectKey: string,
  ) => Promise<string>;
}): Promise<ExecutionContext["resumeSession"]> {
  const resumeSession = args.resumeSession;
  if (!hasResumeSessionHistoryRef(resumeSession)) {
    return resumeSession;
  }

  const { sessionId, historyRef } = resumeSession;
  const gzipRepresentation =
    historyRef.encoding === SESSION_HISTORY_ENCODING_GZIP
      ? await args.loadGzipRepresentation(historyRef.hash)
      : undefined;
  if (
    historyRef.encoding === SESSION_HISTORY_ENCODING_GZIP &&
    gzipRepresentation === undefined
  ) {
    throw invalidResumeSessionHistoryError(
      historyRef.hash,
      new Error("gzip session history metadata is missing"),
    );
  }
  if (gzipRepresentation !== undefined) {
    validateGzipResumeSessionHistoryRepresentation(
      historyRef.hash,
      gzipRepresentation,
    );
  }

  if (gzipRepresentation !== undefined) {
    const url = await args.generateResumeSessionHistoryObjectUrl(
      gzipRepresentation.objectKey,
    );
    return {
      sessionId,
      historyRef: {
        kind: historyRef.kind,
        hash: historyRef.hash,
        url,
        encoding: gzipRepresentation.encoding,
        rawSize: gzipRepresentation.rawSize,
        encodedSize: gzipRepresentation.encodedSize,
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
    },
  };
}

async function buildClaimResponseBody(args: {
  readonly db: Db;
  readonly run: ClaimedRun;
  readonly storedContext: StoredExecutionContext;
  readonly timing: ClaimRouteTimingCollector;
  readonly signal: AbortSignal;
  readonly loadIdentityRepresentation: (
    hash: string,
  ) => Promise<IdentityResumeSessionHistoryRepresentation | undefined>;
  readonly loadGzipRepresentation: (
    hash: string,
  ) => Promise<GzipResumeSessionHistoryRepresentation | undefined>;
  readonly generateResumeSessionHistoryUrl: (hash: string) => Promise<string>;
  readonly generateResumeSessionHistoryObjectUrl: (
    objectKey: string,
  ) => Promise<string>;
}): Promise<ExecutionContext> {
  const featureSwitchContext = await args.timing.measure(
    "claim_route_feature_switch_context",
    "top_level",
    () => {
      return loadUserFeatureSwitchContext(
        args.db,
        args.run.orgId,
        args.run.userId,
      );
    },
  );
  args.signal.throwIfAborted();
  const secretValues = await args.timing.measure(
    "claim_route_secret_materialization",
    "top_level",
    () => {
      return secretValuesForRunner(args.storedContext, featureSwitchContext);
    },
  );
  args.signal.throwIfAborted();
  return await args.timing.measure(
    "claim_route_response_assembly",
    "top_level",
    async () => {
      const resumeSession = await resolveResumeSessionForClaim({
        resumeSession: args.storedContext.resumeSession,
        loadIdentityRepresentation(hash: string) {
          return args.loadIdentityRepresentation(hash);
        },
        loadGzipRepresentation(hash: string) {
          return args.loadGzipRepresentation(hash);
        },
        generateResumeSessionHistoryUrl: args.generateResumeSessionHistoryUrl,
        generateResumeSessionHistoryObjectUrl:
          args.generateResumeSessionHistoryObjectUrl,
      });
      args.signal.throwIfAborted();
      const sandboxToken = generateSandboxToken(
        args.run.userId,
        args.run.id,
        args.run.orgId,
      );
      const refreshedPolicies = await refreshClaimNetworkPolicies({
        db: args.db,
        run: args.run,
        storedContext: args.storedContext,
      });
      args.signal.throwIfAborted();
      return {
        ...args.storedContext,
        runId: args.run.id,
        prompt: args.run.prompt,
        appendSystemPrompt: args.run.appendSystemPrompt,
        agentComposeVersionId: args.run.agentComposeVersionId,
        vars: (args.run.vars as Record<string, string>) ?? null,
        checkpointId: args.run.resumedFromCheckpointId ?? null,
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
      readonly storedContext: StoredExecutionContext;
      readonly timing: ClaimRouteTimingCollector;
      readonly signal: AbortSignal;
    },
  ): Promise<ExecutionContext> => {
    return await buildClaimResponseBody({
      db: args.db,
      run: args.run,
      storedContext: args.storedContext,
      timing: args.timing,
      signal: args.signal,
      loadIdentityRepresentation(hash: string) {
        return set(loadIdentityResumeSessionHistoryRepresentation$, {
          db: args.db,
          hash,
        });
      },
      loadGzipRepresentation(hash: string) {
        return set(loadGzipResumeSessionHistoryRepresentation$, {
          db: args.db,
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

function scheduleSuccessfulClaimSideEffects(args: {
  readonly jobWithRun: ClaimableJob;
  readonly authType: RunnerAuthContext["type"];
  readonly storedContext: StoredExecutionContext;
  readonly claimRequestStartedAtMs: number;
  readonly claimResult: ClaimedTransitionResult;
  readonly telemetry:
    | {
        readonly discoverySource?: string;
        readonly jobDiscoveredToClaimRequestMs?: number;
        readonly localAdmissionToClaimRequestMs?: number;
        readonly pollDueToJobDiscoveredMs?: number;
        readonly pollHttpRequestMs?: number;
        readonly pollReason?: string;
      }
    | undefined;
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

async function recordClaimTimingMetrics(args: {
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
  readonly discoverySource: string | undefined;
  readonly pollDueToJobDiscoveredMs: number | undefined;
  readonly pollHttpRequestMs: number | undefined;
  readonly pollReason: string | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}): Promise<void> {
  await Promise.resolve();
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
    [
      claimTimingOperation(
        args.runId,
        "api_to_runner_queue",
        args.apiToRunnerQueueMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "runner_queue_to_claim_request",
        args.runnerQueueToClaimRequestMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "api_to_claim_request",
        args.apiToClaimRequestMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "api_to_claim",
        args.apiToClaimMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "claim_request_to_running",
        args.claimRequestToRunningMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "job_discovered_to_claim_request",
        args.jobDiscoveredToClaimRequestMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "local_admission_to_claim_request",
        args.localAdmissionToClaimRequestMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "runner_poll_due_to_job_discovered",
        args.pollDueToJobDiscoveredMs,
        dimensions,
      ),
      claimTimingOperation(
        args.runId,
        "runner_poll_http_request",
        args.pollHttpRequestMs,
        dimensions,
      ),
    ].filter((operation): operation is SandboxOperationAttrs => {
      return operation !== undefined;
    }),
  );
  args.claimRouteTiming.flush({
    runId: args.runId,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    authType: args.authType,
    discoverySource: args.discoverySource,
    pollReason: args.pollReason,
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

  const run = jobWithRun.run;

  const contextParseStartedAt = now();
  const storedContextResult = storedExecutionContextSchema.safeParse(
    jobWithRun.job.executionContext,
  );
  claimRouteTiming.recordElapsed(
    "claim_route_context_parse",
    "top_level",
    contextParseStartedAt,
  );
  signal.throwIfAborted();
  if (!storedContextResult.success) {
    warnInvalidStoredExecutionContext(runId, storedContextResult.error.issues);
    return await failClaimForInvalidStoredExecutionContext({
      db,
      runId,
      userId: run.userId,
      orgId: run.orgId,
      signal,
      scheduleFailedSideEffects(args) {
        set(scheduleClaimFailedSideEffects$, args);
      },
    });
  }
  const storedContext = storedContextResult.data;

  const responseBodyResult = await settle(
    set(buildClaimResponseBodyForClaim$, {
      db,
      run,
      storedContext,
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
      scheduleFailedSideEffects(args) {
        set(scheduleClaimFailedSideEffects$, args);
      },
    });
  }
  const responseBody = responseBodyResult.value;
  signal.throwIfAborted();

  const claimResult = await claimRouteTiming.measure(
    "claim_route_transition_running",
    "top_level",
    async () => {
      return await transitionClaimedJobToRunning(
        db,
        runId,
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
    authType: auth.type,
    storedContext,
    claimRequestStartedAtMs,
    claimResult,
    telemetry: body.data.telemetry,
    claimRouteTiming,
  });

  return { status: 200 as const, body: responseBody };
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
    const run = await getActiveRunNetworkPolicyScope(db, runId, signal);
    if (!run) {
      return notFound("Run not found");
    }

    const authError = runnerRunAuthorizationError(auth, run);
    if (authError) {
      return authError;
    }

    const connectorRefs = [...new Set(body.data.connectorRefs)];
    const refreshes = await resolveActiveNetworkPolicyRefreshes(
      db,
      {
        orgId: run.orgId,
        userId: run.userId,
        agentId: run.agentId,
      },
      connectorRefs,
    );
    signal.throwIfAborted();
    if (refreshes.length === 0) {
      return notFound(`Connectors not found: ${connectorRefs.join(", ")}`);
    }

    return {
      status: 200 as const,
      body: {
        refreshes: refreshes.map((refresh) => {
          return {
            connectorRef: refresh.connectorRef,
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
    route: runnerRealtimeTokenContract.create,
    handler: runnerRealtimeTokenInner$,
  },
];
