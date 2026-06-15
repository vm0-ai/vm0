import { command } from "ccstate";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import {
  publishCancelToRunnerGroup,
  publishOrgSignal,
  publishUserSignal,
} from "../external/realtime";
import { logger } from "../../lib/log";
import { notFound, runNotCancellable } from "../../lib/error";
import { tapError } from "../utils";
import { dispatchRunCallbacks } from "./agent-run-callback.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import { drainOrgQueue$ } from "./zero-run-queue.service";

const L = logger("ZeroRunCancel");

export interface CancelRunResult {
  readonly runId: string;
  readonly previousStatus: string;
  readonly userId: string;
  readonly orgId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly alreadyCancelled: boolean;
}

type NotFoundResponse = ReturnType<typeof notFound>;
type RunNotCancellableResponse = ReturnType<typeof runNotCancellable>;

const ACTIVE_STATUSES = ["queued", "pending", "running"] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

interface LockedCancelRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly userId: string;
  readonly orgId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
}

function isActiveStatus(status: string): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Cancel a run. Idempotent for already-cancelled runs (returns success
 * without dispatching side effects). Returns notFound if the run doesn't
 * exist or is owned by another (org, user) tuple. Returns
 * runNotCancellable for non-cancellable terminal statuses.
 *
 * The transactional shape locks the run row first, classifies the
 * current status under that lock, then updates status and removes
 * derived queue/job rows. Side effects use the committed transition.
 */
export const cancelRun$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<
    NotFoundResponse | RunNotCancellableResponse | CancelRunResult
  > => {
    const writeDb = set(writeDb$);

    const result = await writeDb.transaction(async (tx) => {
      const lockedRows = await tx.execute<LockedCancelRunRow>(sql`
        SELECT
          ${agentRuns.id} AS "id",
          ${agentRuns.status} AS "status",
          ${agentRuns.userId} AS "userId",
          ${agentRuns.orgId} AS "orgId",
          ${agentRuns.sandboxId} AS "sandboxId",
          ${agentRuns.runnerGroup} AS "runnerGroup"
        FROM ${agentRuns}
        WHERE ${agentRuns.id} = ${args.runId}
          AND ${agentRuns.userId} = ${args.userId}
          AND ${agentRuns.orgId} = ${args.orgId}
        FOR UPDATE
      `);
      const run = lockedRows.rows[0];
      if (!run) {
        return notFound(`No such run: '${args.runId}'`);
      }

      if (run.status === "cancelled") {
        return {
          runId: args.runId,
          previousStatus: run.status,
          userId: run.userId,
          orgId: run.orgId,
          sandboxId: run.sandboxId,
          runnerGroup: run.runnerGroup,
          alreadyCancelled: true,
        };
      }

      if (!isActiveStatus(run.status)) {
        return runNotCancellable(
          `Run cannot be cancelled: current status is '${run.status}'`,
        );
      }

      const [updated] = await tx
        .update(agentRuns)
        .set({ status: "cancelled", completedAt: nowDate() })
        .where(
          and(eq(agentRuns.id, args.runId), eq(agentRuns.status, run.status)),
        )
        .returning({ id: agentRuns.id });
      if (!updated) {
        throw new Error("Locked cancellable run was not updated");
      }

      await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, args.runId));
      await tx
        .delete(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, args.runId));

      return {
        runId: args.runId,
        previousStatus: run.status,
        userId: run.userId,
        orgId: run.orgId,
        sandboxId: run.sandboxId,
        runnerGroup: run.runnerGroup,
        alreadyCancelled: false,
      };
    });
    signal.throwIfAborted();

    return result;
  },
);

/**
 * Post-cancel side effects:
 *  - Notify the runner group to halt the cancelled run (if it was
 *    running on a runner).
 *  - Publish org-level `queue:changed` and user-level `runChanged`.
 *  - Drain the org queue: promote one queued run to pending. The
 *    runner picks up pending runs on its existing poll loop.
 *  - Reconcile credits via `processOrgUsageEvents$` when the cancelled
 *    run had been doing credit-relevant work (running/pending). The
 *    transactional invariant (events marked processed iff credit
 *    deduction succeeds) is preserved by `processOrgUsageEvents$`.
 *
 * Deferrals (each tracked under #12290):
 *  - `dispatchQueuedZeroRun` (drain dispatch path) — Stage 4
 *    run-creation migration.
 *  - `triggerAutoRecharge` (Stripe top-up) — sibling follow-up.
 *
 * Fire-and-forget caller: invoke from the route handler via
 * `waitUntil(tapError(set(dispatchCancelSideEffects$, result, signal), log))`.
 */
export const dispatchCancelSideEffects$ = command(
  async (
    { set },
    result: CancelRunResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (result.alreadyCancelled) {
      return;
    }
    const db = set(writeDb$);
    if (result.previousStatus === "running" && result.runnerGroup) {
      await publishCancelToRunnerGroup(result.runnerGroup, result.runId);
      signal.throwIfAborted();
    }
    await publishOrgSignal(result.orgId, "queue:changed");
    signal.throwIfAborted();
    await publishUserSignal([result.userId], `runChanged:${result.runId}`, {
      status: "cancelled",
    });
    signal.throwIfAborted();

    await tapError(
      dispatchRunCallbacks(
        db,
        result.runId,
        "failed",
        undefined,
        "Run cancelled",
      ),
      (error) => {
        L.error("Failed to dispatch cancel callbacks", {
          runId: result.runId,
          error,
        });
      },
    );
    signal.throwIfAborted();

    // Promote one queued run to pending; the runner picks it up on its
    // next poll cycle. Queue dispatch (compose loading + sandbox
    // provisioning) lands in Stage 4.
    await set(drainOrgQueue$, { orgId: result.orgId }, signal);
    signal.throwIfAborted();

    // Reconcile credits when the cancelled run had been doing
    // credit-relevant work. Web's invariant: only invoke when
    // previousStatus ∈ {running, pending} — queued runs that never
    // started accumulating usage_event rows skip this (no-op anyway
    // since the pending-events query returns empty).
    if (
      result.previousStatus === "running" ||
      result.previousStatus === "pending"
    ) {
      await set(processOrgUsageEvents$, result.orgId, signal);
      signal.throwIfAborted();
    }
  },
);
