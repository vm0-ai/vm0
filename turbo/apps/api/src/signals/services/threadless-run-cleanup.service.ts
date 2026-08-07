import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@vm0/api-contracts/contracts/runners";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreadEvents } from "@vm0/db/schema/chat-thread-event";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { failPendingInlineOnlyDeliveryCallbacksForDeletedThread } from "./agent-run-callback.service";
import { dispatchCompleteSideEffects$ } from "./agent-webhook-complete.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
} from "./zero-run-cancel.service";
import { drainOrgQueue$ } from "./zero-run-queue.service";

const L = logger("ThreadlessRunCleanup");

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

const THREADLESS_RUN_SWEEP_LIMIT = 20;

// The audited legacy cohort predates this issue. It must remain untouched until
// a separately gated data migration. Newer runs are unambiguously forward
// lifecycle rows. Older runs enter the forward cohort only when their durable
// chat callback can be matched to a post-cutoff thread-deletion tombstone.
const THREADLESS_RUN_FORWARD_CUTOFF_ISO = "2026-08-03T05:40:26.000Z";

interface ThreadlessRunCandidate {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly error: string | null;
  readonly completedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

interface ThreadlessRunCleanupError {
  readonly runId: string;
  readonly error: string;
}

export interface ThreadlessRunCleanupResult {
  readonly discovered: number;
  readonly cancelled: number;
  readonly waiting: number;
  readonly deleted: number;
  readonly failed: number;
  readonly errors: readonly ThreadlessRunCleanupError[];
}

function isActiveStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalError(candidate: ThreadlessRunCandidate): string | undefined {
  if (candidate.status === "completed") {
    return undefined;
  }
  if (candidate.error) {
    return candidate.error;
  }
  if (candidate.status === "cancelled") {
    return "Run cancelled";
  }
  if (candidate.status === "timeout") {
    return "Run timed out";
  }
  return "Run failed";
}

async function loadThreadlessRunCandidates(
  db: Db,
): Promise<readonly ThreadlessRunCandidate[]> {
  const forwardCutoff = new Date(THREADLESS_RUN_FORWARD_CUTOFF_ISO);
  return await db
    .select({
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      status: agentRuns.status,
      error: agentRuns.error,
      completedAt: agentRuns.completedAt,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        isNull(zeroRuns.chatThreadId),
        ne(zeroRuns.triggerSource, "test"),
        inArray(agentRuns.status, [
          ...ACTIVE_RUN_STATUSES,
          ...TERMINAL_RUN_STATUSES,
        ]),
        or(
          gte(agentRuns.createdAt, forwardCutoff),
          exists(
            db
              .select({ id: chatThreadEvents.id })
              .from(agentRunCallbacks)
              .innerJoin(
                chatThreadEvents,
                and(
                  eq(chatThreadEvents.userId, agentRuns.userId),
                  eq(chatThreadEvents.orgId, agentRuns.orgId),
                  eq(chatThreadEvents.kind, "deleted"),
                  gte(chatThreadEvents.createdAt, forwardCutoff),
                  eq(
                    sql`${agentRunCallbacks.payload}->>'threadId'`,
                    sql`${chatThreadEvents.chatThreadId}::text`,
                  ),
                ),
              )
              .where(
                and(
                  eq(agentRunCallbacks.runId, agentRuns.id),
                  eq(agentRunCallbacks.internalKind, "chat"),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))
    .limit(THREADLESS_RUN_SWEEP_LIMIT);
}

function quietWindowElapsed(
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
): boolean {
  return candidate.completedAt !== null && candidate.completedAt <= quietBefore;
}

async function hasDeletionBlocker(
  db: Pick<Db, "select">,
  runId: string,
): Promise<boolean> {
  const [pendingCallback] = await db
    .select({ id: agentRunCallbacks.id })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingCallback) {
    return true;
  }

  const [queuedRun] = await db
    .select({ runId: agentRunQueue.runId })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  if (queuedRun) {
    return true;
  }

  const [runnerJob] = await db
    .select({ runId: runnerJobQueue.runId })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  if (runnerJob) {
    return true;
  }

  const [pendingUsage] = await db
    .select({ id: usageEvent.id })
    .from(usageEvent)
    .where(and(eq(usageEvent.runId, runId), eq(usageEvent.status, "pending")))
    .limit(1);
  return pendingUsage !== undefined;
}

async function deleteIfStillEligible(
  db: Db,
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: agentRuns.status,
        completedAt: agentRuns.completedAt,
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, candidate.runId))
      .for("update");
    if (
      !current ||
      current.status !== candidate.status ||
      current.completedAt?.getTime() !== candidate.completedAt?.getTime() ||
      current.cancellationRecoveryCompleted !==
        candidate.cancellationRecoveryCompleted ||
      !isTerminalStatus(current.status) ||
      current.completedAt === null ||
      current.completedAt > quietBefore
    ) {
      return false;
    }

    const [zeroRun] = await tx
      .select({ chatThreadId: zeroRuns.chatThreadId })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, candidate.runId))
      .limit(1);
    if (!zeroRun || zeroRun.chatThreadId !== null) {
      return false;
    }

    if (await hasDeletionBlocker(tx, candidate.runId)) {
      return false;
    }

    const [deleted] = await tx
      .delete(agentRuns)
      .where(eq(agentRuns.id, candidate.runId))
      .returning({ id: agentRuns.id });
    return deleted !== undefined;
  });
}

async function redriveTerminalLifecycle(
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  db: Db,
  candidate: ThreadlessRunCandidate,
  signal: AbortSignal,
): Promise<void> {
  if (candidate.status === "cancelled") {
    const cancelResult = await set(
      cancelRun$,
      {
        runId: candidate.runId,
        userId: candidate.userId,
        orgId: candidate.orgId,
        runnerCancellationMode: "hard",
      },
      signal,
    );
    signal.throwIfAborted();
    if ("alreadyCancelled" in cancelResult) {
      await set(dispatchCancelSideEffects$, cancelResult, signal);
      signal.throwIfAborted();
    }
  }

  const error = terminalError(candidate);
  await set(
    dispatchCompleteSideEffects$,
    {
      kind: "terminal",
      runId: candidate.runId,
      orgId: candidate.orgId,
      status: candidate.status === "completed" ? "completed" : "failed",
      ...(error === undefined ? {} : { error }),
    },
    signal,
  );
  signal.throwIfAborted();

  await failPendingInlineOnlyDeliveryCallbacksForDeletedThread(
    db,
    candidate.runId,
  );
  signal.throwIfAborted();

  // dispatchCompleteSideEffects$ treats queue publication as best effort for
  // normal webhooks. Deletion requires a strict durable reconciliation pass.
  await set(drainOrgQueue$, { orgId: candidate.orgId }, signal);
  signal.throwIfAborted();
}

export const cleanupThreadlessRuns$ = command(
  async ({ set }, signal: AbortSignal): Promise<ThreadlessRunCleanupResult> => {
    const db = set(writeDb$);
    const candidates = await loadThreadlessRunCandidates(db);
    signal.throwIfAborted();

    let cancelled = 0;
    let waiting = 0;
    let deleted = 0;
    const errors: ThreadlessRunCleanupError[] = [];
    const quietBefore = new Date(
      nowDate().getTime() - CANCELLATION_RECOVERY_STALE_AFTER_MS,
    );

    for (const candidate of candidates) {
      const result = await settle(
        (async () => {
          if (isActiveStatus(candidate.status)) {
            const cancelResult = await set(
              cancelRun$,
              {
                runId: candidate.runId,
                userId: candidate.userId,
                orgId: candidate.orgId,
                runnerCancellationMode: "hard",
              },
              signal,
            );
            signal.throwIfAborted();
            if (!("alreadyCancelled" in cancelResult)) {
              waiting++;
              return;
            }
            await set(dispatchCancelSideEffects$, cancelResult, signal);
            signal.throwIfAborted();
            cancelled++;
            return;
          }

          if (!quietWindowElapsed(candidate, quietBefore)) {
            waiting++;
            return;
          }

          await redriveTerminalLifecycle(set, db, candidate, signal);
          if (await deleteIfStillEligible(db, candidate, quietBefore)) {
            deleted++;
          } else {
            waiting++;
          }
        })(),
        signal,
      );
      if (!result.ok) {
        errors.push({
          runId: candidate.runId,
          error: errorMessage(result.error),
        });
      }
    }

    const cleanupResult = {
      discovered: candidates.length,
      cancelled,
      waiting,
      deleted,
      failed: errors.length,
      errors,
    };
    if (candidates.length > 0) {
      L.debug("Threadless run cleanup completed", cleanupResult);
    }
    return cleanupResult;
  },
);
