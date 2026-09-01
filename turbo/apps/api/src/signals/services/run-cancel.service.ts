import { command } from "ccstate";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { and, eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishChatThreadDetailChangedSafely,
  type RunnerCancellationMode,
} from "../external/realtime";
import { logger } from "../../lib/log";
import { notFound, runNotCancellable } from "../../lib/error";
import { now } from "../../lib/time";
import { tapError } from "../utils";
import {
  chatCallbackIdForRun,
  dispatchFailedRunCallbacks,
  dispatchRunCallbacks$,
} from "./agent-run-callback.service";
import { drainChatThreadQueueForRun$ } from "./chat-thread-queue-drain.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { drainOrgQueue$ } from "./agent-run-lifecycle.service";
import {
  abortPiApiFirstTurnAfterCanonicalCancellation,
  lockPiApiFirstTurnLifecycle,
} from "./pi-api-first-turn-lifecycle.service";

const L = logger("RunCancel");

export interface CancelRunResult {
  readonly apiStartTime: number;
  readonly runId: string;
  readonly previousStatus: string;
  readonly userId: string;
  readonly orgId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly runnerCancellationMode: RunnerCancellationMode;
  readonly alreadyCancelled: boolean;
}

type NotFoundResponse = ReturnType<typeof notFound>;
type RunNotCancellableResponse = ReturnType<typeof runNotCancellable>;

async function abortAfterCanonicalCancellation<T>(
  transition: Promise<T>,
): Promise<T> {
  const result = await transition;
  if (
    typeof result === "object" &&
    result !== null &&
    "alreadyCancelled" in result &&
    "runId" in result &&
    typeof result.runId === "string"
  ) {
    abortPiApiFirstTurnAfterCanonicalCancellation(result.runId);
  }
  return result;
}

const ACTIVE_STATUSES = ["queued", "pending", "running"] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

function isActiveStatus(status: string): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Cancel a run. Idempotent for already-cancelled runs. Recovery-capable
 * cancellations may redrive only their retry-safe callback and thread-drain
 * side effects; legacy cancellations return success without side effects.
 * Returns notFound if the run doesn't exist or is owned by another (org,
 * user) tuple. Returns runNotCancellable for non-cancellable terminal
 * statuses.
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
      readonly runnerCancellationMode: RunnerCancellationMode;
      readonly apiStartTime?: number;
    },
    signal: AbortSignal,
  ): Promise<
    NotFoundResponse | RunNotCancellableResponse | CancelRunResult
  > => {
    const apiStartTime = args.apiStartTime ?? now();
    const writeDb = set(writeDb$);

    const transition = writeDb.transaction(async (tx) => {
      await lockPiApiFirstTurnLifecycle(tx, args.runId);
      const [run] = await tx
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          userId: agentRuns.userId,
          orgId: agentRuns.orgId,
          sandboxId: agentRuns.sandboxId,
          runnerGroup: agentRuns.runnerGroup,
          chatThreadId: agentRuns.chatThreadId,
          cancellationRecoveryCompleted:
            agentRuns.cancellationRecoveryCompleted,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
          ),
        )
        .for("update");
      if (!run) {
        return notFound(`No such run: '${args.runId}'`);
      }

      if (run.status === "cancelled") {
        return {
          apiStartTime,
          runId: args.runId,
          previousStatus: run.status,
          userId: run.userId,
          orgId: run.orgId,
          sandboxId: run.sandboxId,
          runnerGroup: run.runnerGroup,
          chatThreadId: run.chatThreadId,
          cancellationRecoveryCompleted: run.cancellationRecoveryCompleted,
          runnerCancellationMode: args.runnerCancellationMode,
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
        .set({
          status: "cancelled",
          completedAt: new Date(apiStartTime),
        })
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
        apiStartTime,
        runId: args.runId,
        previousStatus: run.status,
        userId: run.userId,
        orgId: run.orgId,
        sandboxId: run.sandboxId,
        runnerGroup: run.runnerGroup,
        chatThreadId: run.chatThreadId,
        cancellationRecoveryCompleted: run.cancellationRecoveryCompleted,
        runnerCancellationMode: args.runnerCancellationMode,
        alreadyCancelled: false,
      };
    });
    const result = await abortAfterCanonicalCancellation(transition);
    signal.throwIfAborted();

    return result;
  },
);

export function shouldDispatchCancelSideEffects(
  result: CancelRunResult,
): boolean {
  return (
    !result.alreadyCancelled || result.cancellationRecoveryCompleted !== null
  );
}

async function cancellationLifecyclePublished(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        eq(chatEvents.eventType, "run.cancelled"),
      ),
    )
    .limit(1);
  return event !== undefined;
}

async function publishCancellationRecoveryEntered(
  result: CancelRunResult,
  signal: AbortSignal,
): Promise<void> {
  if (
    result.alreadyCancelled ||
    result.cancellationRecoveryCompleted === null ||
    result.chatThreadId === null
  ) {
    return;
  }
  await publishChatThreadDetailChangedSafely(
    result.userId,
    result.chatThreadId,
  );
  signal.throwIfAborted();
}

async function publishRunnerCancellation(
  result: CancelRunResult,
  signal: AbortSignal,
): Promise<void> {
  if (
    result.alreadyCancelled ||
    result.previousStatus !== "running" ||
    !result.runnerGroup
  ) {
    return;
  }
  // A null marker identifies a historical claim without the API recovery
  // barrier, so cooperative cancellation is unsafe even when requested.
  const mode =
    result.cancellationRecoveryCompleted === null
      ? "hard"
      : result.runnerCancellationMode;
  await tapError(
    publishCancelToRunnerGroup(result.runnerGroup, result.runId, mode),
    (error) => {
      L.error("Failed to publish cancel to runner group", {
        runId: result.runId,
        runnerGroup: result.runnerGroup,
        error,
      });
    },
  );
  signal.throwIfAborted();
}

/**
 * Post-cancel side effects:
 *  - Notify the runner group to halt the cancelled run (if it was
 *    running on a runner).
 *  - Drain the org queue: promote one queued run to pending. The
 *    runner picks up pending runs on its existing poll loop.
 *  - Reconcile credits via `processOrgUsageEvents$` when the cancelled
 *    run had been doing credit-relevant work (running/pending). The
 *    transactional invariant (events marked processed iff credit
 *    deduction succeeds) is preserved by `processOrgUsageEvents$`.
 *
 * Deferrals (each tracked under #12290):
 *  - queued-run dispatch (drain dispatch path) — Stage 4
 *    run-creation migration.
 *  - `triggerAutoRecharge` (Stripe top-up) — sibling follow-up.
 *
 * Fire-and-forget caller: invoke from the route handler via `waitUntil(...)`
 * with a detached background signal after `cancelRun$` commits.
 */
export const dispatchCancelSideEffects$ = command(
  async (
    { set },
    result: CancelRunResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!shouldDispatchCancelSideEffects(result)) {
      return;
    }
    const recoveryRedrive = result.alreadyCancelled;
    const db = set(writeDb$);
    await publishCancellationRecoveryEntered(result, signal);
    await publishRunnerCancellation(result, signal);

    const chatCallbackId = await chatCallbackIdForRun(db, result.runId);
    signal.throwIfAborted();
    // Once the callback's durable lifecycle marker exists, replay would only
    // repeat its pre-marker work. The direct scheduler redrive below is enough.
    const redriveChatCallbackId =
      recoveryRedrive &&
      chatCallbackId !== undefined &&
      !(await cancellationLifecyclePublished(db, result.runId))
        ? chatCallbackId
        : undefined;
    signal.throwIfAborted();
    const callbackResults =
      recoveryRedrive && redriveChatCallbackId === undefined
        ? []
        : await tapError(
            set(
              dispatchRunCallbacks$,
              {
                db,
                runId: result.runId,
                status: "failed",
                error: "Run cancelled",
                ...(redriveChatCallbackId !== undefined
                  ? { redriveChatCallbackId }
                  : {}),
              },
              signal,
            ),
            (error) => {
              L.error("Failed to dispatch cancel callbacks", {
                runId: result.runId,
                error,
              });
            },
          );
    signal.throwIfAborted();

    const chatCallbackDrained = callbackResults?.some((callbackResult) => {
      return (
        callbackResult.callbackId === chatCallbackId && callbackResult.success
      );
    });
    if (result.cancellationRecoveryCompleted !== null || !chatCallbackDrained) {
      await tapError(
        set(
          drainChatThreadQueueForRun$,
          {
            runId: result.runId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            apiStartTime: result.apiStartTime,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain chat thread queue after cancel", {
            runId: result.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    if (recoveryRedrive) {
      return;
    }

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
