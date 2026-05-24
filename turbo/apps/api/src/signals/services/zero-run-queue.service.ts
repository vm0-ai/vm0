import { command } from "ccstate";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { and, count, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { publishOrgSignal } from "../external/realtime";
import { logger } from "../../lib/log";
import { decryptQueuedRunnerJobPayload } from "./agent-run-queue-payload.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";

const L = logger("ZeroRunQueue");

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;

const TIER_CONCURRENCY_LIMITS: Readonly<Record<OrgTier, number>> =
  Object.freeze({
    free: 1,
    pro: 2,
    team: 10,
  });

function tierLimit(tier: OrgTier | null | undefined): number {
  if (!tier) {
    return TIER_CONCURRENCY_LIMITS.free;
  }
  return TIER_CONCURRENCY_LIMITS[tier];
}

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type QueuedRunnerJobPayload = NonNullable<
  Awaited<ReturnType<typeof decryptQueuedRunnerJobPayload>>
>;

async function promoteApiQueuedRunnerJob(
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
  await tx
    .update(agentRuns)
    .set({ runnerGroup: args.payload.runnerGroup })
    .where(eq(agentRuns.id, args.runId));
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

    const transitioned = await writeDb.transaction(async (tx) => {
      // Serialize all queue operations for this org; same hash as web.
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
        return { promoted: 0, runnerNotification: null };
      }

      const queueRows = await tx
        .select({
          runId: agentRunQueue.runId,
          userId: agentRunQueue.userId,
          createdAt: agentRunQueue.createdAt,
          encryptedParams: agentRunQueue.encryptedParams,
        })
        .from(agentRunQueue)
        .where(eq(agentRunQueue.orgId, args.orgId))
        .orderBy(agentRunQueue.createdAt);

      let promoted = 0;
      for (const row of queueRows) {
        await tx
          .delete(agentRunQueue)
          .where(eq(agentRunQueue.runId, row.runId));
        const [updated] = await tx
          .update(agentRuns)
          .set({ status: "pending", lastHeartbeatAt: nowDate() })
          .where(
            and(eq(agentRuns.id, row.runId), eq(agentRuns.status, "queued")),
          )
          .returning({ id: agentRuns.id });
        if (!updated) {
          L.debug("drainOrgQueue: queued run already transitioned, skipping", {
            runId: row.runId,
          });
          continue;
        }
        const featureSwitchContext = await loadUserFeatureSwitchContext(
          tx,
          args.orgId,
          row.userId,
        );
        const payload = await decryptQueuedRunnerJobPayload(
          row.encryptedParams,
          featureSwitchContext,
        );
        if (payload) {
          await promoteApiQueuedRunnerJob(tx, {
            orgId: args.orgId,
            runId: row.runId,
            queuedAt: row.createdAt,
            payload,
          });
        }
        promoted = 1;
        return payload
          ? {
              promoted,
              runnerNotification: {
                runId: row.runId,
                runnerGroup: payload.runnerGroup,
                profile: payload.profile,
                sessionId: payload.sessionId,
              },
            }
          : { promoted, runnerNotification: null };
      }

      return { promoted, runnerNotification: null };
    });
    signal.throwIfAborted();

    await publishOrgSignal(args.orgId, "queue:changed");
    signal.throwIfAborted();

    if (transitioned.runnerNotification) {
      await notifyRunnerJob(writeDb, transitioned.runnerNotification);
      signal.throwIfAborted();
    }

    return transitioned.promoted;
  },
);

export const cleanupExpiredQueueEntries$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();

    const deleted = await writeDb
      .delete(agentRunQueue)
      .where(lt(agentRunQueue.expiresAt, currentTime))
      .returning({ runId: agentRunQueue.runId });
    signal.throwIfAborted();

    if (deleted.length === 0) {
      return 0;
    }

    await writeDb
      .update(agentRuns)
      .set({
        status: "timeout",
        completedAt: currentTime,
        error: "Queued run expired (exceeded queue TTL)",
      })
      .where(
        and(
          inArray(
            agentRuns.id,
            deleted.map((entry) => {
              return entry.runId;
            }),
          ),
          eq(agentRuns.status, "queued"),
        ),
      );
    signal.throwIfAborted();

    L.debug("Cleaned up expired queue entries", { count: deleted.length });
    return deleted.length;
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
