import { command, type Computed } from "ccstate";
import {
  PI_STANDBY_PROFILE,
  type RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import type { PersistedStorageMount } from "@vm0/db/types";
import type { ExecutionEnv } from "@vm0/pi-agent-runtime";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import {
  publishOrgSignal,
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { logger } from "../../lib/log";
import { activePendingRunPredicate } from "./agent-run-activity.service";
import { decryptQueuedRunnerJobPayload } from "./agent-run-queue-payload.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  revokeQueuedRunAssistantMarkers,
  type QueueMarkerRevokeNotification,
} from "./zero-chat-queue-marker.service";
import {
  cappedBaseConcurrencyLimit,
  loadOrgConcurrencyState,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { tapError } from "../utils";
import type { Tx } from "../../lib/db-types";
import {
  activatePendingRun$,
  type PendingRunActivation,
} from "./agent-run-activation.service";
import type { PiEdgeModelConfig } from "./pi-edge-config";
import { loadPiLaunchStorageResources } from "./pi-storage-execution-env.service";

const L = logger("ZeroRunQueue");

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const QUEUED_RUN_EXPIRED_REASON = "Queued run expired (exceeded queue TTL)";
const QUEUED_RUN_LAUNCH_ORPHAN_REASON =
  "Queued run timed out before queue entry was persisted";

async function effectiveOrgConcurrencyState(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<{ readonly activeRunCount: number; readonly limit: number }> {
  const at = nowDate();
  const state = await loadOrgConcurrencyState(db, {
    orgId,
    at,
    activePendingAfter: new Date(at.getTime() - PENDING_RUN_TTL_MS),
  });
  const baseLimit = cappedBaseConcurrencyLimit(state.baseConcurrencyLimit);
  return {
    activeRunCount: state.activeRunCount,
    limit: totalConcurrencyLimit({ baseLimit, paidSlots: state.paidSlots }),
  };
}

type DbTransaction = Tx;
type QueuedRunnerJobPayload = NonNullable<
  Awaited<ReturnType<typeof decryptQueuedRunnerJobPayload>>
>;

interface QueueCandidate {
  readonly runId: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly encryptedParams: string | null;
  readonly runStatus: string | null;
  readonly chatThreadId: string | null;
  readonly storageMounts: PersistedStorageMount[] | null;
}

interface PromotedRunnerJob {
  readonly createdAt: Date;
  readonly apiStartedAt: number;
  readonly profile: string;
}

interface PreparedQueuedPiEdgeTurn {
  readonly model: PiEdgeModelConfig;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly executionEnv: ExecutionEnv;
  readonly skillSnapshot: RunSkillSnapshot;
}

type PromoteQueuedCandidateResult =
  | {
      readonly status: "promoted";
      readonly pendingActivation: PendingRunActivation | null;
      readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
    }
  | { readonly status: "full" }
  | { readonly status: "removed-stale" }
  | { readonly status: "lost" };

type PromoteQueuedCandidateSideEffectResult =
  | {
      readonly status: "drained";
      readonly pendingActivation: PendingRunActivation | null;
    }
  | { readonly status: "full" }
  | { readonly status: "skipped" };

interface TimedOutQueuedRunRow {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
}

export interface QueuedRunMaintenanceTimeout {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly error: string;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}

interface QueuedRunMaintenanceResult {
  readonly deletedCount: number;
  readonly timedOutRuns: readonly QueuedRunMaintenanceTimeout[];
}

async function timedOutQueuedRunsWithMarkerNotifications(
  tx: DbTransaction,
  rows: readonly TimedOutQueuedRunRow[],
  error: string,
): Promise<QueuedRunMaintenanceTimeout[]> {
  const timedOutRuns: QueuedRunMaintenanceTimeout[] = [];
  for (const row of rows) {
    timedOutRuns.push({
      ...row,
      error,
      queueMarkerNotification: await revokeQueuedRunAssistantMarkers(tx, {
        runId: row.runId,
        userId: row.userId,
      }),
    });
  }
  return timedOutRuns;
}

async function insertPromotedRunnerJob(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly runId: string;
    readonly queuedAt: Date;
    readonly payload: QueuedRunnerJobPayload;
  },
): Promise<PromotedRunnerJob> {
  const promotedAt = now();
  const [remainingRow] = await tx
    .select({ depth: count() })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.orgId, args.orgId));

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "dequeue_zero_run",
    durationMs: Math.max(0, promotedAt - args.queuedAt.getTime()),
    success: true,
    runId: args.runId,
    dimensions: {
      queue_depth_at_dequeue: Number(remainingRow?.depth ?? 0),
    },
  });

  await tx
    .update(zeroRuns)
    .set({ apiStartedAt: new Date(promotedAt) })
    .where(eq(zeroRuns.id, args.runId));

  const timestamps = runnerJobQueueTimestamps();
  const profile =
    args.payload.piEdge === undefined
      ? args.payload.profile
      : PI_STANDBY_PROFILE;
  const [runnerJob] = await tx
    .insert(runnerJobQueue)
    .values({
      runId: args.runId,
      runnerGroup: args.payload.runnerGroup,
      profile,
      cliAgentSessionId: args.payload.cliAgentSessionId,
      reuseKey: args.payload.reuseKey,
      executionContext: {
        ...args.payload.executionContext,
        apiStartTime: promotedAt,
      },
      ...timestamps,
    })
    .returning({ createdAt: runnerJobQueue.createdAt });
  if (!runnerJob) {
    throw new Error("Promoted runner job queue insert returned no row");
  }
  return {
    createdAt: runnerJob.createdAt,
    apiStartedAt: promotedAt,
    profile,
  };
}

async function loadDrainCandidates(
  db: Db,
  orgId: string,
): Promise<readonly QueueCandidate[]> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);

    const concurrency = await effectiveOrgConcurrencyState(tx, orgId);
    if (concurrency.activeRunCount >= concurrency.limit) {
      return [];
    }

    return await tx
      .select({
        runId: agentRunQueue.runId,
        userId: agentRunQueue.userId,
        createdAt: agentRunQueue.createdAt,
        encryptedParams: agentRunQueue.encryptedParams,
        runStatus: agentRuns.status,
        storageMounts: agentRuns.storageMounts,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRunQueue)
      .leftJoin(agentRuns, eq(agentRunQueue.runId, agentRuns.id))
      .leftJoin(zeroRuns, eq(agentRunQueue.runId, zeroRuns.id))
      .where(eq(agentRunQueue.orgId, orgId))
      .orderBy(agentRunQueue.createdAt);
  });
}

async function prepareQueuedPiEdgeTurn(
  get: <T>(computedValue: Computed<T>) => T,
  db: Db,
  row: QueueCandidate,
  payload: QueuedRunnerJobPayload,
): Promise<PreparedQueuedPiEdgeTurn | undefined> {
  if (payload.piEdge === undefined) {
    return undefined;
  }
  const systemPrompt = payload.executionContext.piSystemPrompt;
  const skillSnapshot = payload.executionContext.runSkillSnapshot;
  if (
    row.storageMounts === null ||
    systemPrompt === undefined ||
    skillSnapshot === undefined
  ) {
    throw new Error(`Queued Pi run "${row.runId}" is missing launch context`);
  }
  const resources = await loadPiLaunchStorageResources(get, db, {
    snapshot: skillSnapshot,
    persistedStorageMounts: row.storageMounts,
  });
  return {
    model: payload.piEdge.model,
    prompt: payload.piEdge.prompt,
    systemPrompt,
    executionEnv: resources.env,
    skillSnapshot,
  };
}

async function promoteQueuedCandidate(
  db: Db,
  args: {
    readonly orgId: string;
    readonly row: QueueCandidate;
    readonly payload: QueuedRunnerJobPayload | null;
    readonly piEdgeTurn: PreparedQueuedPiEdgeTurn | undefined;
  },
): Promise<PromoteQueuedCandidateResult> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
    );

    const concurrency = await effectiveOrgConcurrencyState(tx, args.orgId);
    if (concurrency.activeRunCount >= concurrency.limit) {
      return { status: "full" };
    }

    const [lockedRun] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.row.runId))
      .for("update");
    if (!lockedRun) {
      await tx
        .delete(agentRunQueue)
        .where(eq(agentRunQueue.runId, args.row.runId));
      return { status: "removed-stale" };
    }
    if (lockedRun.status !== "queued") {
      await tx
        .delete(agentRunQueue)
        .where(eq(agentRunQueue.runId, args.row.runId));
      return { status: "removed-stale" };
    }
    if (args.row.runStatus !== "queued") {
      return { status: "lost" };
    }

    const [queueRow] = await tx
      .select({ runId: agentRunQueue.runId })
      .from(agentRunQueue)
      .where(
        and(
          eq(agentRunQueue.runId, args.row.runId),
          eq(agentRunQueue.orgId, args.orgId),
        ),
      )
      .limit(1);
    if (!queueRow) {
      return { status: "lost" };
    }

    const runValues = args.payload
      ? {
          status: "pending",
          lastHeartbeatAt: nowDate(),
          runnerGroup: args.payload.runnerGroup,
        }
      : {
          status: "pending",
          lastHeartbeatAt: nowDate(),
        };
    const [updated] = await tx
      .update(agentRuns)
      .set(runValues)
      .where(
        and(eq(agentRuns.id, args.row.runId), eq(agentRuns.status, "queued")),
      )
      .returning({ id: agentRuns.id });
    if (!updated) {
      return { status: "lost" };
    }

    await tx
      .delete(agentRunQueue)
      .where(eq(agentRunQueue.runId, args.row.runId));

    const queueMarkerNotification = await revokeQueuedRunAssistantMarkers(tx, {
      runId: args.row.runId,
      userId: args.row.userId,
    });

    if (!args.payload) {
      return {
        status: "promoted",
        pendingActivation: null,
        queueMarkerNotification,
      };
    }

    const runnerJob = await insertPromotedRunnerJob(tx, {
      orgId: args.orgId,
      runId: args.row.runId,
      queuedAt: args.row.createdAt,
      payload: args.payload,
    });
    return {
      status: "promoted",
      queueMarkerNotification,
      pendingActivation: {
        apiStartTime: runnerJob.apiStartedAt,
        chatThreadId: args.row.chatThreadId ?? undefined,
        piEdgeTurn:
          args.piEdgeTurn === undefined
            ? undefined
            : {
                ...args.piEdgeTurn,
                runId: args.row.runId,
                userId: args.row.userId,
                orgId: args.orgId,
                runnerGroup: args.payload.runnerGroup,
                apiStartTime: runnerJob.apiStartedAt,
              },
        runnerNotification: {
          runId: args.row.runId,
          runnerGroup: args.payload.runnerGroup,
          profile: runnerJob.profile,
          reuseKey: args.payload.reuseKey,
          cliAgentSessionId: args.payload.cliAgentSessionId,
          historyGenerationRunId: args.payload.historyGenerationRunId,
          createdAt: runnerJob.createdAt,
        },
      },
    };
  });
}

async function publishRemovedStaleQueueSideEffects(
  orgId: string,
): Promise<void> {
  await tapError(publishOrgSignal(orgId, "queue:changed"), (error) => {
    L.error("Failed to publish queue changed after stale queue removal", {
      orgId,
      error,
    });
  });
}

async function publishPromotedQueueSideEffects(args: {
  readonly orgId: string;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}): Promise<void> {
  await tapError(publishOrgSignal(args.orgId, "queue:changed"), (error) => {
    L.error("Failed to publish queue changed after queued run promotion", {
      orgId: args.orgId,
      error,
    });
  });

  if (args.queueMarkerNotification) {
    await tapError(
      publishUserSignal(
        [args.queueMarkerNotification.userId],
        `chatThreadMessageCreated:${args.queueMarkerNotification.chatThreadId}`,
      ),
      (error) => {
        L.error("Failed to publish queued marker notification", {
          userId: args.queueMarkerNotification?.userId,
          chatThreadId: args.queueMarkerNotification?.chatThreadId,
          error,
        });
      },
    );
    await tapError(
      publishThreadListChanged(args.queueMarkerNotification.userId),
      (error) => {
        L.error("Failed to publish thread list changed after queue promotion", {
          userId: args.queueMarkerNotification?.userId,
          error,
        });
      },
    );
  }
}

async function promoteQueuedCandidateWithSideEffects(
  db: Db,
  args: {
    readonly orgId: string;
    readonly row: QueueCandidate;
    readonly payload: QueuedRunnerJobPayload | null;
    readonly piEdgeTurn: PreparedQueuedPiEdgeTurn | undefined;
  },
): Promise<PromoteQueuedCandidateSideEffectResult> {
  const result = await promoteQueuedCandidate(db, args);
  if (result.status === "removed-stale") {
    await publishRemovedStaleQueueSideEffects(args.orgId);
    return { status: "skipped" };
  }
  if (result.status === "full") {
    return { status: "full" };
  }
  if (result.status === "lost") {
    L.debug("drainOrgQueue: queued run already transitioned, skipping", {
      runId: args.row.runId,
    });
    return { status: "skipped" };
  }

  await publishPromotedQueueSideEffects({
    orgId: args.orgId,
    queueMarkerNotification: result.queueMarkerNotification,
  });
  return {
    status: "drained",
    pendingActivation: result.pendingActivation,
  };
}

/**
 * Drain the org's queued runs after a concurrency slot frees up.
 *
 * Scope: API-created queue entries carry a prepared runner job payload
 * in `agent_run_queue.encrypted_params`. Draining promotes one queued run
 * to pending and inserts the matching `runner_job_queue` row so the runner
 * can claim it. Legacy or fixture entries without that payload still get
 * the SQL-only queued → pending transition for compatibility.
 *
 * Acquires `pg_advisory_xact_lock(hashtext(orgId))` — same hash key as
 * web's `drainOrgQueue` so the two backends serialize correctly on the
 * same org during rollout.
 *
 * Returns the number of runs transitioned (0 if queue empty or
 * concurrency full).
 */
export const drainOrgQueue$ = command(
  async (
    { get, set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);

    const queueRows = await loadDrainCandidates(writeDb, args.orgId);
    signal.throwIfAborted();

    for (const row of queueRows) {
      const payload =
        row.runStatus === "queued"
          ? await decryptQueuedRunnerJobPayload(row.encryptedParams)
          : null;
      signal.throwIfAborted();
      const piEdgeTurn =
        payload === null
          ? undefined
          : await prepareQueuedPiEdgeTurn(get, writeDb, row, payload);
      signal.throwIfAborted();

      const result = await promoteQueuedCandidateWithSideEffects(writeDb, {
        orgId: args.orgId,
        row,
        payload,
        piEdgeTurn,
      });
      signal.throwIfAborted();
      if (result.status === "full") {
        return 0;
      }
      if (result.status === "skipped") {
        continue;
      }
      if (result.pendingActivation !== null) {
        await tapError(
          set(activatePendingRun$, result.pendingActivation, signal),
          (error) => {
            L.error("Failed to activate promoted queued run", {
              runId: row.runId,
              orgId: args.orgId,
              error,
            });
          },
        );
        signal.throwIfAborted();
      }
      return 1;
    }

    return 0;
  },
);

export const drainOrgQueueToCapacity$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    let drained = 0;
    while (true) {
      const promoted = await set(drainOrgQueue$, args, signal);
      signal.throwIfAborted();
      if (promoted === 0) {
        return drained;
      }
      drained += promoted;
    }
  },
);

export const cleanupExpiredQueueEntries$ = command(
  async ({ set }, signal: AbortSignal): Promise<QueuedRunMaintenanceResult> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const expiredRunIds = tx
        .select({ runId: agentRunQueue.runId })
        .from(agentRunQueue)
        .where(lt(agentRunQueue.expiresAt, currentTime));

      const candidates = await tx
        .select({
          runId: agentRuns.id,
        })
        .from(agentRuns)
        .where(
          and(
            inArray(agentRuns.id, expiredRunIds),
            eq(agentRuns.status, "queued"),
          ),
        )
        .orderBy(agentRuns.createdAt, agentRuns.id)
        .for("update");
      signal.throwIfAborted();

      const candidateRunIds = candidates.map((candidate) => {
        return candidate.runId;
      });

      const timedOut =
        candidateRunIds.length === 0
          ? []
          : await tx
              .update(agentRuns)
              .set({
                status: "timeout",
                completedAt: currentTime,
                error: QUEUED_RUN_EXPIRED_REASON,
              })
              .where(
                and(
                  inArray(agentRuns.id, candidateRunIds),
                  eq(agentRuns.status, "queued"),
                ),
              )
              .returning({
                runId: agentRuns.id,
                orgId: agentRuns.orgId,
                userId: agentRuns.userId,
              });
      const timedOutRuns = await timedOutQueuedRunsWithMarkerNotifications(
        tx,
        timedOut,
        QUEUED_RUN_EXPIRED_REASON,
      );

      const deletableRows = await tx
        .select({ runId: agentRunQueue.runId })
        .from(agentRunQueue)
        .leftJoin(agentRuns, eq(agentRunQueue.runId, agentRuns.id))
        .where(
          and(
            lt(agentRunQueue.expiresAt, currentTime),
            or(isNull(agentRuns.id), ne(agentRuns.status, "queued")),
          ),
        );

      if (deletableRows.length === 0) {
        return { deletedCount: 0, timedOutRuns };
      }

      const deleted = await tx
        .delete(agentRunQueue)
        .where(
          inArray(
            agentRunQueue.runId,
            deletableRows.map((entry) => {
              return entry.runId;
            }),
          ),
        )
        .returning({ runId: agentRunQueue.runId });

      return {
        deletedCount: deleted.length,
        timedOutRuns,
      };
    });
    signal.throwIfAborted();

    if (result.deletedCount > 0 || result.timedOutRuns.length > 0) {
      L.debug("Cleaned up expired queue entries", {
        count: result.deletedCount,
        timedOut: result.timedOutRuns.length,
      });
    }
    return result;
  },
);

export const cleanupQueuedRunLaunchOrphans$ = command(
  async (
    { set },
    cutoff: Date,
    signal: AbortSignal,
  ): Promise<QueuedRunMaintenanceResult> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const candidates = await tx
        .select({
          runId: agentRuns.id,
          orgId: agentRuns.orgId,
          userId: agentRuns.userId,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.status, "queued"),
            lt(agentRuns.createdAt, cutoff),
            notExists(
              tx
                .select({ runId: agentRunQueue.runId })
                .from(agentRunQueue)
                .where(eq(agentRunQueue.runId, agentRuns.id)),
            ),
          ),
        )
        .orderBy(agentRuns.createdAt, agentRuns.id)
        .for("update");
      signal.throwIfAborted();

      if (candidates.length === 0) {
        return { deletedCount: 0, timedOutRuns: [] };
      }

      const candidateRunIds = candidates.map((candidate) => {
        return candidate.runId;
      });

      // Queue persistence locks the run before inserting agent_run_queue. If
      // this transaction waited for that lock, re-check the queue table with a
      // fresh statement before timing out the run.
      const timedOut = await tx
        .update(agentRuns)
        .set({
          status: "timeout",
          completedAt: currentTime,
          error: QUEUED_RUN_LAUNCH_ORPHAN_REASON,
        })
        .where(
          and(
            eq(agentRuns.status, "queued"),
            inArray(agentRuns.id, candidateRunIds),
            notExists(
              tx
                .select({ runId: agentRunQueue.runId })
                .from(agentRunQueue)
                .where(eq(agentRunQueue.runId, agentRuns.id)),
            ),
          ),
        )
        .returning({
          runId: agentRuns.id,
          orgId: agentRuns.orgId,
          userId: agentRuns.userId,
        });
      const timedOutRuns = await timedOutQueuedRunsWithMarkerNotifications(
        tx,
        timedOut,
        QUEUED_RUN_LAUNCH_ORPHAN_REASON,
      );

      return { deletedCount: 0, timedOutRuns };
    });
    signal.throwIfAborted();

    if (result.timedOutRuns.length > 0) {
      L.debug("Cleaned up queued run launch orphans", {
        timedOut: result.timedOutRuns.length,
      });
    }
    return result;
  },
);

export const drainStaleQueues$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const writeDb = set(writeDb$);
    const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);

    const orgsWithQueued = await writeDb
      .selectDistinct({ orgId: agentRunQueue.orgId })
      .from(agentRunQueue);
    signal.throwIfAborted();

    let drained = 0;
    for (const { orgId } of orgsWithQueued) {
      const [activeRow] = await writeDb
        .select({ count: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, orgId),
            or(
              eq(agentRuns.status, "running"),
              and(
                eq(agentRuns.status, "pending"),
                activePendingRunPredicate(staleThreshold),
              ),
            ),
          ),
        );
      signal.throwIfAborted();

      const activeCount = Number(activeRow?.count ?? 0);
      if (activeCount === 0) {
        L.debug("Draining stale queue", { orgId });
        await set(drainOrgQueue$, { orgId }, signal);
        signal.throwIfAborted();
        drained++;
      }
    }

    return drained;
  },
);
