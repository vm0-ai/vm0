import { command, state, computed } from "ccstate";
import { delay } from "signal-timers";
import {
  zeroRunsQueueContract,
  zeroRunsCancelContract,
  type QueueResponse,
  type QueueEntry,
  type RunningTask,
} from "@vm0/core";
import { throwIfAbort } from "../utils.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const POLL_INTERVAL = 5000;

export type { QueueEntry, RunningTask };
export type QueueData = QueueResponse;

const internalQueueData$ = state<QueueData | null>(null);

export const queueData$ = computed((get) => {
  return get(internalQueueData$);
});

const fetchQueueData$ = command(async ({ get, set }, _signal: AbortSignal) => {
  const client = get(zeroClient$)(zeroRunsQueueContract);
  const result = await accept(client.getQueue(), [200], { toast: false });
  set(internalQueueData$, result.body);
});

export const startQueuePolling$ = command(
  async ({ set }, signal: AbortSignal) => {
    // Initial fetch
    await set(fetchQueueData$, signal);
    signal.throwIfAborted();

    // Polling loop
    while (!signal.aborted) {
      try {
        await delay(POLL_INTERVAL, { signal });
        signal.throwIfAborted();
        await set(fetchQueueData$, signal);
        signal.throwIfAborted();
      } catch (error) {
        throwIfAbort(error);
        // Swallow non-abort errors and continue polling
      }
    }
  },
);

export const cancelQueueRun$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroRunsCancelContract);
    await accept(client.cancel({ params: { id: runId } }), [200]);
    signal.throwIfAborted();
    // Refresh queue data after cancel
    await set(fetchQueueData$, signal);
  },
);
