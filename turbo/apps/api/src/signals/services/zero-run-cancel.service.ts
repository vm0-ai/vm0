import { command } from "ccstate";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq, inArray } from "drizzle-orm";

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

/**
 * Cancel a run. Idempotent for already-cancelled runs (returns success
 * without dispatching side effects). Returns notFound if the run doesn't
 * exist or is owned by another (org, user) tuple. Returns
 * runNotCancellable for non-cancellable terminal statuses.
 *
 * The transactional shape (DELETE queue + UPDATE status guarded by
 * allowed-from list, with a re-read on lost-race) mirrors web's
 * `cancelRun` and is the correctness anchor for concurrent cancel
 * attempts.
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

    const [run] = await writeDb
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

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

    if (!(ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
      return runNotCancellable(
        `Run cannot be cancelled: current status is '${run.status}'`,
      );
    }

    const cancelled = await writeDb.transaction(async (tx) => {
      await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, args.runId));
      const [updated] = await tx
        .update(agentRuns)
        .set({ status: "cancelled", completedAt: nowDate() })
        .where(
          and(
            eq(agentRuns.id, args.runId),
            inArray(agentRuns.status, [...ACTIVE_STATUSES]),
          ),
        )
        .returning({ id: agentRuns.id });
      return Boolean(updated);
    });
    signal.throwIfAborted();

    if (cancelled) {
      return {
        runId: args.runId,
        previousStatus: run.status,
        userId: run.userId,
        orgId: run.orgId,
        sandboxId: run.sandboxId,
        runnerGroup: run.runnerGroup,
        alreadyCancelled: false,
      };
    }

    // Lost the race: another writer transitioned the row first. Re-read
    // and classify — if the winner moved it to cancelled the user's intent
    // is satisfied and we respond idempotently; any other terminal state
    // is a genuine error.
    const [current] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (current?.status === "cancelled") {
      return {
        runId: args.runId,
        previousStatus: "cancelled",
        userId: run.userId,
        orgId: run.orgId,
        sandboxId: run.sandboxId,
        runnerGroup: run.runnerGroup,
        alreadyCancelled: true,
      };
    }

    return runNotCancellable(
      `Run cannot be cancelled: status has already changed`,
    );
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
