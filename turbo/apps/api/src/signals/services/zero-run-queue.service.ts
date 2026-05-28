import { command } from "ccstate";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import {
  publishOrgSignal,
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { logger } from "../../lib/log";
import { decryptQueuedRunnerJobPayload } from "./agent-run-queue-payload.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  revokeQueuedRunAssistantMarkers,
  type QueueMarkerRevokeNotification,
} from "./zero-chat-queue-marker.service";

const L = logger("ZeroRunQueue");

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;

const TIER_CONCURRENCY_LIMITS: Readonly<Record<OrgTier, number>> =
  Object.freeze({
    free: 1,
    "pro-suspend": 0,
    pro: 2,
    team: 10,
  });

function tierLimit(tier: OrgTier | null | undefined): number {
  if (!tier) {
    return TIER_CONCURRENCY_LIMITS["pro-suspend"];
  }
  return TIER_CONCURRENCY_LIMITS[tier];
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
  readonly sessionId: string | null;
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

interface LockedQueueRunRow extends Record<string, unknown> {
  readonly status: string;
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
    sessionId: args.payload.sessionId,
    executionContext: {
      ...args.payload.executionContext,
      apiStartTime: promotedAt,
    },
    expiresAt: new Date(promotedAt + 2 * 60 * 60 * 1000),
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
    const limit = tierLimit(orgRow?.tier as OrgTier | null | undefined);

    const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);
    const [activeRow] = await tx
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
    const activeCount = Number(activeRow?.count ?? 0);
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
    const limit = tierLimit(orgRow?.tier as OrgTier | null | undefined);

    const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);
    const [activeRow] = await tx
      .select({ count: count() })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, args.orgId),
          or(
            eq(agentRuns.status, "running"),
            and(
              eq(agentRuns.status, "pending"),
              gt(agentRuns.createdAt, staleThreshold),
            ),
          ),
        ),
      );
    const activeCount = Number(activeRow?.count ?? 0);
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
        sessionId: args.payload.sessionId,
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

      const result = await promoteQueuedCandidate(writeDb, {
        orgId: args.orgId,
        row,
        payload,
      });
      signal.throwIfAborted();
      if (result.status === "removed-stale") {
        await publishOrgSignal(args.orgId, "queue:changed");
        signal.throwIfAborted();
        continue;
      }
      if (result.status === "full") {
        return 0;
      }
      if (result.status === "lost") {
        L.debug("drainOrgQueue: queued run already transitioned, skipping", {
          runId: row.runId,
        });
        continue;
      }

      await publishOrgSignal(args.orgId, "queue:changed");
      signal.throwIfAborted();

      if (result.queueMarkerNotification) {
        await publishUserSignal(
          [result.queueMarkerNotification.userId],
          `chatThreadMessageCreated:${result.queueMarkerNotification.chatThreadId}`,
        );
        signal.throwIfAborted();
        await publishThreadListChanged(result.queueMarkerNotification.userId);
        signal.throwIfAborted();
      }

      if (result.runnerNotification) {
        await notifyRunnerJob(writeDb, result.runnerNotification);
        signal.throwIfAborted();
      }

      return 1;
    }

    return 0;
  },
);

export const cleanupExpiredQueueEntries$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const expiredRunIds = tx
        .select({ runId: agentRunQueue.runId })
        .from(agentRunQueue)
        .where(lt(agentRunQueue.expiresAt, currentTime));

      const timedOut = await tx
        .update(agentRuns)
        .set({
          status: "timeout",
          completedAt: currentTime,
          error: "Queued run expired (exceeded queue TTL)",
        })
        .where(
          and(
            inArray(agentRuns.id, expiredRunIds),
            eq(agentRuns.status, "queued"),
          ),
        )
        .returning({ runId: agentRuns.id });

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
        return { deletedCount: 0, timedOutCount: timedOut.length };
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
        timedOutCount: timedOut.length,
      };
    });
    signal.throwIfAborted();

    if (result.deletedCount === 0) {
      return 0;
    }

    L.debug("Cleaned up expired queue entries", {
      count: result.deletedCount,
      timedOut: result.timedOutCount,
    });
    return result.deletedCount;
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
                gt(agentRuns.createdAt, staleThreshold),
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
