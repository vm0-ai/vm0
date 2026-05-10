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
import { notFound, runNotCancellable } from "../../lib/error";
import { drainOrgQueue$ } from "./zero-run-queue.service";

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
 *  - Publish org-level `queue:changed` for UI refresh.
 *  - Publish user-level `runChanged:<runId>` for UI run row refresh.
 *  - Drain the org queue: promote one queued run to pending if a slot
 *    is now free. The runner picks up pending runs on its existing
 *    poll loop; queue dispatch (load compose + start sandbox) lands in
 *    the Stage 4 run-creation migration.
 *
 * Credit reconciliation (`processOrgUsageEvents`) remains deferred to
 * a sibling follow-up — the credit-deduction chain (deductOrgCredits +
 * expireCredits + triggerAutoRecharge + evaluateMemberCaps) requires
 * substantial infrastructure that doesn't yet exist on the api side.
 *
 * Fire-and-forget caller: invoke from the route handler via
 * `waitUntil(set(dispatchCancelSideEffects$, result, signal).catch(log))`.
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

    // Promote one queued run to pending; the runner picks it up on its
    // next poll cycle. Queue dispatch (compose loading + sandbox
    // provisioning) lands in Stage 4.
    await set(drainOrgQueue$, { orgId: result.orgId }, signal);
    signal.throwIfAborted();
  },
);
