import { command } from "ccstate";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { and, count, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import {
  publishOrgSignal,
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { logger } from "../../lib/log";
import { activePendingRunPredicate } from "./agent-run-activity.service";
import { decryptQueuedRunnerJobPayload } from "./agent-run-queue-payload.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  revokeQueuedRunAssistantMarkers,
  type QueueMarkerRevokeNotification,
} from "./zero-chat-queue-marker.service";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { tapError } from "../utils";

const L = logger("ZeroRunQueue");

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const QUEUED_RUN_EXPIRED_REASON = "Queued run expired (exceeded queue TTL)";
const QUEUED_RUN_LAUNCH_ORPHAN_REASON =
  "Queued run timed out before queue entry was persisted";

const TIER_CONCURRENCY_LIMITS: Readonly<Record<OrgTier, number>> =
  Object.freeze({
    free: 1,
    "limited-free-1": 1,
    "pro-suspend": 0,
    pro: 2,
    team: 10,
  });

async function effectiveOrgConcurrencyLimit(
  db: Pick<Db, "select">,
  orgId: string,
  tier: OrgTier | null | undefined,
): Promise<number> {
  const baseLimit = cappedBaseConcurrencyLimit(
    tier
      ? TIER_CONCURRENCY_LIMITS[tier]
      : TIER_CONCURRENCY_LIMITS["pro-suspend"],
  );
  const paidSlots = await activePaidConcurrencySlots(db, orgId);
  return totalConcurrencyLimit({ baseLimit, paidSlots });
}

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type QueuedRunnerJobPayload = NonNullable<
  Awaited<ReturnType<typeof decryptQueuedRunnerJobPayload>>
>;

interface QueueCandidate {
  readonly runId: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly encryptedParams: string | null;
  readonly runStatus: string | null;
}

interface RunnerNotification {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
}

type PromoteQueuedCandidateResult =
  | {
      readonly status: "promoted";
      readonly runnerNotification: RunnerNotification | null;
      readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
    }
  | { readonly status: "full" }
  | { readonly status: "removed-stale" }
  | { readonly status: "lost" };

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

interface LockedQueueRunRow extends Record<string, unknown> {
  readonly status: string;
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

async function activeConcurrencyCount(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<number> {
  const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);
  const [activeRow] = await db
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
  return Number(activeRow?.count ?? 0);
}

async function insertPromotedRunnerJob(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly runId: string;
    readonly queuedAt: Date;
    readonly payload: QueuedRunnerJobPayload;
  },
): Promise<void> {
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

  await tx.insert(runnerJobQueue).values({
    runId: args.runId,
    runnerGroup: args.payload.runnerGroup,
    profile: args.payload.profile,
    cliAgentSessionId: args.payload.cliAgentSessionId,
    executionContext: {
      ...args.payload.executionContext,
      apiStartTime: promotedAt,
    },
    expiresAt: sql`now() + interval '2 hours'`,
  });
}

async function loadDrainCandidates(
  db: Db,
  orgId: string,
): Promise<readonly QueueCandidate[]> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);

    const [orgRow] = await tx
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    const limit = await effectiveOrgConcurrencyLimit(
      tx,
      orgId,
      orgRow?.tier as OrgTier | null | undefined,
    );

    const activeCount = await activeConcurrencyCount(tx, orgId);
    if (activeCount >= limit) {
      return [];
    }

    return await tx
      .select({
        runId: agentRunQueue.runId,
        userId: agentRunQueue.userId,
        createdAt: agentRunQueue.createdAt,
        encryptedParams: agentRunQueue.encryptedParams,
        runStatus: agentRuns.status,
      })
      .from(agentRunQueue)
      .leftJoin(agentRuns, eq(agentRunQueue.runId, agentRuns.id))
      .where(eq(agentRunQueue.orgId, orgId))
      .orderBy(agentRunQueue.createdAt);
  });
}

async function promoteQueuedCandidate(
  db: Db,
  args: {
    readonly orgId: string;
    readonly row: QueueCandidate;
    readonly payload: QueuedRunnerJobPayload | null;
  },
): Promise<PromoteQueuedCandidateResult> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
    );

    const [orgRow] = await tx
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    const limit = await effectiveOrgConcurrencyLimit(
      tx,
      args.orgId,
      orgRow?.tier as OrgTier | null | undefined,
    );

    const activeCount = await activeConcurrencyCount(tx, args.orgId);
    if (activeCount >= limit) {
      return { status: "full" };
    }

    const lockedRunRows = await tx.execute<LockedQueueRunRow>(sql`
      SELECT ${agentRuns.status} AS "status"
      FROM ${agentRuns}
      WHERE ${agentRuns.id} = ${args.row.runId}
      FOR UPDATE
    `);
    const lockedRun = lockedRunRows.rows[0];
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
        runnerNotification: null,
        queueMarkerNotification,
      };
    }

    await insertPromotedRunnerJob(tx, {
      orgId: args.orgId,
      runId: args.row.runId,
      queuedAt: args.row.createdAt,
      payload: args.payload,
    });
    return {
      status: "promoted",
      queueMarkerNotification,
      runnerNotification: {
        runId: args.row.runId,
        runnerGroup: args.payload.runnerGroup,
        profile: args.payload.profile,
        cliAgentSessionId: args.payload.cliAgentSessionId,
      },
    };
  });
}

async function loadQueuedRunnerJobPayload(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly encryptedParams: string | null;
  },
  signal: AbortSignal,
): Promise<QueuedRunnerJobPayload | null> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  signal.throwIfAborted();
  const payload = await decryptQueuedRunnerJobPayload(
    args.encryptedParams,
    featureSwitchContext,
  );
  signal.throwIfAborted();
  return payload;
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

async function publishPromotedQueueSideEffects(
  db: Db,
  args: {
    readonly orgId: string;
    readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
    readonly runnerNotification: RunnerNotification | null;
  },
): Promise<void> {
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

  if (args.runnerNotification) {
    await tapError(notifyRunnerJob(db, args.runnerNotification), (error) => {
      L.error("Failed to notify runner after queued run promotion", {
        runId: args.runnerNotification?.runId,
        runnerGroup: args.runnerNotification?.runnerGroup,
        error,
      });
    });
  }
}

async function promoteQueuedCandidateWithSideEffects(
  db: Db,
  args: {
    readonly orgId: string;
    readonly row: QueueCandidate;
    readonly payload: QueuedRunnerJobPayload | null;
  },
): Promise<"drained" | "full" | "skipped"> {
  const result = await promoteQueuedCandidate(db, args);
  if (result.status === "removed-stale") {
    await publishRemovedStaleQueueSideEffects(args.orgId);
    return "skipped";
  }
  if (result.status === "full") {
    return "full";
  }
  if (result.status === "lost") {
    L.debug("drainOrgQueue: queued run already transitioned, skipping", {
      runId: args.row.runId,
    });
    return "skipped";
  }

  await publishPromotedQueueSideEffects(db, {
    orgId: args.orgId,
    queueMarkerNotification: result.queueMarkerNotification,
    runnerNotification: result.runnerNotification,
  });
  return "drained";
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
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);

    const queueRows = await loadDrainCandidates(writeDb, args.orgId);
    signal.throwIfAborted();

    for (const row of queueRows) {
      const payload =
        row.runStatus === "queued"
          ? await loadQueuedRunnerJobPayload(
              writeDb,
              {
                orgId: args.orgId,
                userId: row.userId,
                encryptedParams: row.encryptedParams,
              },
              signal,
            )
          : null;

      const result = await promoteQueuedCandidateWithSideEffects(writeDb, {
        orgId: args.orgId,
        row,
        payload,
      });
      signal.throwIfAborted();
      if (result === "full") {
        return 0;
      }
      if (result === "skipped") {
        continue;
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
            sql<boolean>`NOT EXISTS (
              SELECT 1
              FROM ${agentRunQueue}
              WHERE ${agentRunQueue.runId} = ${agentRuns.id}
            )`,
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
            sql<boolean>`NOT EXISTS (
              SELECT 1
              FROM ${agentRunQueue}
              WHERE ${agentRunQueue.runId} = ${agentRuns.id}
            )`,
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
