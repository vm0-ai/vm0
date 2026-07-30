import { command } from "ccstate";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { staleChatThreadQueueThreadIds } from "./workflow-chat-event-queue.service";
import {
  drainQueuedUserMessagesForThread$,
  type ChatCallbackPreCreateTimingCollector,
} from "./internal-chat-run-callback.service";
import {
  drainWorkflowQueueForThread$,
  type WorkflowQueueDrainResult,
} from "./zero-workflow-queue-drain.service";
import { drainGoalQueueForThread$ } from "./zero-goal-queue-drain.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";

const DRAIN_SWEEP_LIMIT = 20;
const STALE_QUEUE_ITEM_AGE_MS = 5 * 60 * 1000;

interface DrainChatThreadQueueInput {
  readonly chatThreadId: string;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly queueItemCreatedBefore?: Date;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
  readonly workflowEventLaunch?: {
    readonly eventId: string;
    readonly apiStartTime: number;
    readonly timing: ApiDispatchTimingCollector;
  };
}

/**
 * The single per-thread scheduler entry: terminal run callbacks, cancel,
 * resume, and the stale sweep all converge here. User messages are attempted
 * first; workflow automation remains second and goal continuation third. Each
 * later drain observes a newly-created active run and stops. The final claims
 * serialize on the same thread row and fold pending events by class priority,
 * then original `created_at` and id.
 *
 * This entry is the designated mounting point for a future unified per-thread
 * rate limiter: admission delays belong here, before either drain half runs.
 */
export const drainChatThreadQueueForThread$ = command(
  async (
    { set },
    input: DrainChatThreadQueueInput,
    signal: AbortSignal,
  ): Promise<WorkflowQueueDrainResult | null> => {
    await set(
      drainQueuedUserMessagesForThread$,
      {
        chatThreadId: input.chatThreadId,
        queueItemCreatedBefore: input.queueItemCreatedBefore,
        timing: input.timing,
      },
      signal,
    );
    signal.throwIfAborted();
    const workflowResult = await set(
      drainWorkflowQueueForThread$,
      {
        chatThreadId: input.chatThreadId,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        queueItemCreatedBefore: input.queueItemCreatedBefore,
        ...(input.workflowEventLaunch
          ? { workflowEventLaunch: input.workflowEventLaunch }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (workflowResult) {
      return workflowResult;
    }
    await set(
      drainGoalQueueForThread$,
      {
        chatThreadId: input.chatThreadId,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        queueItemCreatedBefore: input.queueItemCreatedBefore,
      },
      signal,
    );
    return null;
  },
);

/** Resolve a terminal run's thread before entering the shared scheduler. */
export const drainChatThreadQueueForRun$ = command(
  async (
    { set },
    input: {
      readonly runId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ chatThreadId: zeroRuns.chatThreadId })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, input.runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return;
    }
    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: run.chatThreadId,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
      },
      signal,
    );
  },
);

/** Re-enter the shared scheduler for workflow queues missed by callbacks. */
export const drainStaleChatThreadQueues$ = command(
  async (
    { set },
    input: { readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const staleBefore = new Date(nowDate().getTime() - STALE_QUEUE_ITEM_AGE_MS);
    const threadIds = await staleChatThreadQueueThreadIds(db, {
      staleBefore,
      limit: DRAIN_SWEEP_LIMIT,
    });
    signal.throwIfAborted();
    for (const chatThreadId of threadIds) {
      await set(
        drainChatThreadQueueForThread$,
        {
          chatThreadId,
          dispatchFailedCallbacks: input.dispatchFailedCallbacks,
          queueItemCreatedBefore: staleBefore,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return threadIds.length;
  },
);
