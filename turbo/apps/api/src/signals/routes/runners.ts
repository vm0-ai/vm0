import { command } from "ccstate";
import {
  elapsedSinceApiStartMs,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
  storedExecutionContextSchema,
  type StoredExecutionContext,
} from "@vm0/api-contracts/contracts/runners";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import { and, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";

import { runnerAuth$, type RunnerAuthContext } from "../auth/runner-auth";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import {
  createRunnerGroupRealtimeToken,
  publishRunChangedForUserSafely,
} from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { generateSandboxToken } from "../auth/tokens";
import { decryptSecretsMap } from "../services/crypto.utils";
import type { RouteEntry } from "../route";

const L = logger("Runners");

const STALE_RUNNER_THRESHOLD_MS = 5 * 60 * 1000;

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

  const currentDate = nowDate();
  const db = set(writeDb$);
  await db
    .insert(runnerState)
    .values({
      runnerId: body.data.runnerId,
      runnerName: body.data.runnerName,
      runnerGroup: body.data.group,
      profiles: body.data.profiles,
      totalVcpu: body.data.totalVcpu,
      totalMemoryMb: body.data.totalMemoryMb,
      maxConcurrent: body.data.maxConcurrent,
      allocatedVcpu: body.data.allocatedVcpu,
      allocatedMemoryMb: body.data.allocatedMemoryMb,
      runningCount: body.data.runningCount,
      heldSessions: body.data.heldSessions,
      mode: body.data.mode,
      lastSeenAt: currentDate,
    })
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: {
        runnerName: body.data.runnerName,
        runnerGroup: body.data.group,
        profiles: body.data.profiles,
        totalVcpu: body.data.totalVcpu,
        totalMemoryMb: body.data.totalMemoryMb,
        maxConcurrent: body.data.maxConcurrent,
        allocatedVcpu: body.data.allocatedVcpu,
        allocatedMemoryMb: body.data.allocatedMemoryMb,
        runningCount: body.data.runningCount,
        heldSessions: body.data.heldSessions,
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

const pollInner$ = command(async ({ get, set }, signal: AbortSignal) => {
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

  const { group, profiles, heldSessions } = body.data;
  const whereConditions: SQL<unknown>[] = [
    eq(runnerJobQueue.runnerGroup, group),
    isNull(runnerJobQueue.claimedAt),
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

  if (profiles && profiles.length > 0) {
    whereConditions.push(inArray(runnerJobQueue.profile, profiles));
  }

  const orderClauses =
    heldSessions && heldSessions.length > 0
      ? [
          sql`CASE WHEN ${runnerJobQueue.sessionId} IN (${sql.join(
            heldSessions.map((session) => {
              return sql`${session}`;
            }),
            sql`, `,
          )}) THEN 0 ELSE 1 END`,
          runnerJobQueue.createdAt,
        ]
      : [runnerJobQueue.createdAt];

  const db = set(writeDb$);
  const [pendingJob] = await db
    .select({
      runId: runnerJobQueue.runId,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      agentComposeVersionId: agentRuns.agentComposeVersionId,
      vars: agentRuns.vars,
      resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
      profile: runnerJobQueue.profile,
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .where(and(...whereConditions))
    .orderBy(...orderClauses)
    .limit(1);
  signal.throwIfAborted();

  if (!pendingJob) {
    return { status: 200 as const, body: { job: null } };
  }

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
      },
    },
  };
});

const claimBody$ = bodyResultOf(runnersJobClaimContract.claim);

interface ClaimableJob {
  readonly job: typeof runnerJobQueue.$inferSelect;
  readonly runUserId: string;
}

interface ClaimedRun {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly agentComposeVersionId: string | null;
  readonly vars: unknown;
  readonly resumedFromCheckpointId: string | null;
}

type ClaimLookupResult =
  | ClaimableJob
  | ReturnType<typeof conflict>
  | ReturnType<typeof notFound>;

function isClaimableJob(value: ClaimLookupResult): value is ClaimableJob {
  return "job" in value;
}

async function getClaimableJob(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<ClaimLookupResult> {
  const [jobWithRun] = await db
    .select({
      job: runnerJobQueue,
      runUserId: agentRuns.userId,
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .where(
      and(eq(runnerJobQueue.runId, runId), isNull(runnerJobQueue.claimedAt)),
    )
    .limit(1);
  signal.throwIfAborted();

  if (jobWithRun) {
    return jobWithRun;
  }

  const [existingJob] = await db
    .select({ runId: runnerJobQueue.runId })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();

  return existingJob
    ? conflict("Job already claimed")
    : notFound("Job not found in queue");
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

  if (jobWithRun.runUserId !== auth.userId) {
    return forbidden("Job does not belong to user");
  }
  return isOfficialRunnerGroup(jobWithRun.job.runnerGroup)
    ? null
    : forbidden("Only vm0/* runner groups are supported");
}

async function markJobClaimed(
  db: Db,
  runId: string,
  claimedAt: Date,
  signal: AbortSignal,
) {
  const [claimedJob] = await db
    .update(runnerJobQueue)
    .set({ claimedAt })
    .where(
      and(eq(runnerJobQueue.runId, runId), isNull(runnerJobQueue.claimedAt)),
    )
    .returning();
  signal.throwIfAborted();
  return claimedJob ?? null;
}

async function markRunRunning(
  db: Db,
  runId: string,
  claimedAt: Date,
  signal: AbortSignal,
): Promise<ClaimedRun | null> {
  const [run] = await db
    .update(agentRuns)
    .set({
      status: "running",
      startedAt: claimedAt,
      lastHeartbeatAt: claimedAt,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "pending")))
    .returning({
      id: agentRuns.id,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      agentComposeVersionId: agentRuns.agentComposeVersionId,
      vars: agentRuns.vars,
      resumedFromCheckpointId: agentRuns.resumedFromCheckpointId,
    });
  signal.throwIfAborted();
  return run ?? null;
}

function secretValuesForRunner(
  storedContext: StoredExecutionContext,
): string[] | null {
  const secretsMap = decryptSecretsMap(storedContext.encryptedSecrets);
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

const claimInner$ = command(async ({ get, set }, signal: AbortSignal) => {
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

  const params = get(pathParamsOf(runnersJobClaimContract.claim));
  const runId = params.id;
  const db = set(writeDb$);

  const jobWithRun = await getClaimableJob(db, runId, signal);
  if (!isClaimableJob(jobWithRun)) {
    return jobWithRun;
  }
  const authError = claimAuthorizationError(auth, jobWithRun);
  if (authError) {
    return authError;
  }

  const currentTime = now();
  const claimedAt = new Date(currentTime);
  const claimedJob = await markJobClaimed(db, runId, claimedAt, signal);
  if (!claimedJob) {
    return conflict("Job was claimed by another runner");
  }

  const run = await markRunRunning(db, runId, claimedAt, signal);
  if (!run) {
    return notFound("Run not found");
  }

  await publishRunChangedForUserSafely(run.userId, runId, {
    status: "running",
  });
  signal.throwIfAborted();

  const storedContextResult = storedExecutionContextSchema.safeParse(
    claimedJob.executionContext,
  );
  if (!storedContextResult.success) {
    L.warn("Runner job missing valid execution context", { runId });
    return badRequestMessage("Job missing execution context");
  }
  const storedContext = storedContextResult.data;

  const sandboxToken = generateSandboxToken(run.userId, run.id, run.orgId);

  const apiToClaimMs = elapsedSinceApiStartMs(
    storedContext.apiStartTime,
    currentTime,
  );
  if (apiToClaimMs !== undefined) {
    recordSandboxOperation({
      sandboxType: "runner",
      actionType: "api_to_claim",
      durationMs: apiToClaimMs,
      success: true,
      runId,
    });
  }

  await db.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ...storedContext,
      runId: run.id,
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt,
      agentComposeVersionId: run.agentComposeVersionId,
      vars: (run.vars as Record<string, string>) ?? null,
      checkpointId: run.resumedFromCheckpointId ?? null,
      sandboxToken,
      secretValues: secretValuesForRunner(storedContext),
    },
  };
});

const runnerRealtimeTokenBody$ = bodyResultOf(
  runnerRealtimeTokenContract.create,
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
    route: runnerRealtimeTokenContract.create,
    handler: runnerRealtimeTokenInner$,
  },
];
