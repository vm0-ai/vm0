import { command } from "ccstate";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { pendingChatThreadQueueThreadIds } from "./chat-message-queue.service";
import {
  drainQueuedUserMessagesForThread$,
  type ChatCallbackPreCreateTimingCollector,
} from "./internal-chat-run-callback.service";
import { drainWorkflowQueueForThread$ } from "./zero-workflow-queue-drain.service";

const DRAIN_SWEEP_LIMIT = 20;

interface DrainChatThreadQueueInput {
  readonly chatThreadId: string;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}

/**
 * The single per-thread scheduler entry: terminal run callbacks, cancel,
 * resume, and the stale sweep all converge here. User messages are attempted
 * first; the workflow drain then observes the newly-created active run and
 * stops, or consumes the oldest workflow event when no user message
 * dispatched. Both halves serialize on the same per-thread advisory lock and
 * pop in `ORDER BY created_at, id` order.
 *
 * This entry is the designated mounting point for a future unified per-thread
 * rate limiter: admission delays belong here, before either drain half runs.
 */
export const drainChatThreadQueueForThread$ = command(
  async (
    { set },
    input: DrainChatThreadQueueInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      drainQueuedUserMessagesForThread$,
      { chatThreadId: input.chatThreadId, timing: input.timing },
      signal,
    );
    signal.throwIfAborted();
    await set(
      drainWorkflowQueueForThread$,
      {
        chatThreadId: input.chatThreadId,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
      },
      signal,
    );
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
    const threadIds = await pendingChatThreadQueueThreadIds(
      db,
      DRAIN_SWEEP_LIMIT,
    );
    signal.throwIfAborted();
    for (const chatThreadId of threadIds) {
      await set(
        drainChatThreadQueueForThread$,
        {
          chatThreadId,
          dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return threadIds.length;
  },
);
