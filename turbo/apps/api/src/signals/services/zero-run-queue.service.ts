import { command } from "ccstate";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, count, eq, gt, or, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { now, nowDate } from "../external/time";
import { publishOrgSignal } from "../external/realtime";
import { logger } from "../../lib/log";

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

/**
 * Drain the org's queued runs after a concurrency slot frees up.
 *
 * Scope: SQL-only port of web's `drainOrgQueue` minus the dispatch
 * callback (`dispatchQueuedZeroRun`). Web's dispatch callback hands off
 * to the run-execution path (compose loading, sandbox provisioning,
 * etc.) which is part of the Stage 4 run-creation migration. The api
 * side here performs the SQL transition (queued → pending) and
 * publishes `queue:changed`. Runners pick up pending runs on their
 * existing poll loop.
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
        return 0;
      }

      const queueRows = await tx
        .select({ runId: agentRunQueue.runId })
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
          // Run was cancelled or otherwise transitioned between enqueue
          // and drain — skip and try the next entry.
          L.debug("drainOrgQueue: queued run already transitioned, skipping", {
            runId: row.runId,
          });
          continue;
        }
        promoted = 1;
        // Web's `dequeueNextAtomic` returns after the first successful
        // transition (one slot freed = one dispatch). Match that to
        // avoid over-dequeuing.
        break;
      }

      return promoted;
    });
    signal.throwIfAborted();

    // Publish queue:changed after a drain attempt — either we promoted
    // a run, or the caller upstream freed the slot (e.g. cancel) and
    // the queue view must refresh even when the queue was empty.
    await publishOrgSignal(args.orgId, "queue:changed");
    signal.throwIfAborted();

    return transitioned;
  },
);
