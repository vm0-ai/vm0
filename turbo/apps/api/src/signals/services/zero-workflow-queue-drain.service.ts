import { triggerSourceSchema } from "@vm0/api-contracts/contracts/logs";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflows,
  zeroWorkflowTriggers,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { publishChatThreadWorkflowQueueChangedSafely } from "../external/realtime";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  claimNextWorkflowQueueEvent,
  decryptWorkflowQueueEventParams,
  pendingWorkflowQueueThreadIds,
  restoreWorkflowQueueEventAndPause,
  type ClaimedWorkflowQueueEvent,
} from "./zero-workflow-queue.service";
import { runWorkflowTriggerNow$ } from "./zero-workflow-trigger-run.service";

const log = logger("ZeroWorkflowQueueDrain");

// Consecutive stale events (deleted/disabled triggers) skipped per drain call
// before giving up; a successful run creation always stops the loop.
const MAX_DRAIN_ATTEMPTS = 5;

const DRAIN_SWEEP_LIMIT = 20;

interface DequeueTarget {
  readonly trigger: typeof zeroWorkflowTriggers.$inferSelect;
  readonly agentId: string;
  readonly workflowName: string;
}

async function loadDequeueTarget(
  db: Db,
  event: ClaimedWorkflowQueueEvent,
): Promise<DequeueTarget | null> {
  const [row] = await db
    .select({
      trigger: zeroWorkflowTriggers,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowTriggers.workflowId),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.id, event.triggerId),
        eq(zeroWorkflowTriggers.orgId, event.orgId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Advance the thread's workflow queue: as long as user queued messages always
 * win (enforced inside `claimNextWorkflowQueueEvent`), pop the oldest event
 * and turn it into a run. Events whose trigger disappeared or can no longer
 * fire are consumed and skipped; a run-creation failure restores the event to
 * the queue head and pauses the queue so the backlog is preserved.
 */
export const drainWorkflowQueueForThread$ = command(
  async (
    { set },
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
      const event = await claimNextWorkflowQueueEvent(db, args.chatThreadId);
      signal.throwIfAborted();
      if (!event) {
        return;
      }

      const target = await loadDequeueTarget(db, event);
      signal.throwIfAborted();
      if (!target) {
        log.debug("Dropping workflow queue event without trigger", {
          eventId: event.id,
          triggerId: event.triggerId,
        });
        await publishChatThreadWorkflowQueueChangedSafely(
          event.userId,
          event.chatThreadId,
        );
        signal.throwIfAborted();
        continue;
      }

      const params = await decryptWorkflowQueueEventParams(
        event.encryptedParams,
        { userId: event.userId, orgId: event.orgId },
      );
      signal.throwIfAborted();
      if (!params) {
        log.error("Dropping undecryptable workflow queue event", {
          eventId: event.id,
          triggerId: event.triggerId,
        });
        continue;
      }

      const triggerSource = triggerSourceSchema.safeParse(event.triggerSource);
      const result = await set(
        runWorkflowTriggerNow$,
        {
          due: {
            trigger: target.trigger,
            agentId: target.agentId,
            workflowName: target.workflowName,
            chatThreadId: event.chatThreadId,
          },
          apiStartTime: now(),
          prompt: params.prompt,
          triggerBrief: event.triggerBrief ?? undefined,
          triggerSource: triggerSource.success ? triggerSource.data : undefined,
          appendSystemPrompt: params.appendSystemPrompt,
          callbacks: params.callbacks,
          activePreviousRunPolicy: "allow",
          recordLastRunId: params.recordLastRunId,
          recordLastRunAt: params.recordLastRunAt,
          bypassWorkflowQueue: true,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();

      if (result.kind === "ok" || result.kind === "enqueued") {
        await publishChatThreadWorkflowQueueChangedSafely(
          event.userId,
          event.chatThreadId,
        );
        signal.throwIfAborted();
        return;
      }
      if (result.kind === "conflict") {
        log.debug("Skipping unfireable workflow queue event", {
          eventId: event.id,
          triggerId: event.triggerId,
          message: result.message,
        });
        continue;
      }

      await restoreWorkflowQueueEventAndPause(db, {
        event,
        pauseReason: result.response.body.error.message,
        pausedAt: nowDate(),
      });
      signal.throwIfAborted();
      log.warn("Workflow queue paused after run creation failure", {
        eventId: event.id,
        chatThreadId: event.chatThreadId,
        code: result.response.body.error.code,
      });
      await publishChatThreadWorkflowQueueChangedSafely(
        event.userId,
        event.chatThreadId,
      );
      signal.throwIfAborted();
      return;
    }
  },
);

/**
 * Terminal-run hook: resolve the run's chat thread and advance that thread's
 * workflow queue. No-op for runs without a chat thread or threads without a
 * workflow queue.
 */
export const drainWorkflowQueueForRun$ = command(
  async (
    { set },
    args: { readonly runId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ chatThreadId: zeroRuns.chatThreadId })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return;
    }
    await set(
      drainWorkflowQueueForThread$,
      { chatThreadId: run.chatThreadId },
      signal,
    );
  },
);

/**
 * Safety-net sweep for the cleanup cron: re-drain workflow queues that have
 * pending events but no in-flight run, covering terminal-run drains that were
 * lost (process crash, dropped callback).
 */
export const drainStaleWorkflowQueues$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const threadIds = await pendingWorkflowQueueThreadIds(
      db,
      DRAIN_SWEEP_LIMIT,
    );
    signal.throwIfAborted();
    for (const chatThreadId of threadIds) {
      await set(drainWorkflowQueueForThread$, { chatThreadId }, signal);
      signal.throwIfAborted();
    }
    return threadIds.length;
  },
);
