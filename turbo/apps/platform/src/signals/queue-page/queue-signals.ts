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

const POLL_INTERVAL = 5000;

export type { QueueEntry, RunningTask };
export type QueueData = QueueResponse;

const internalQueueData$ = state<QueueData | null>(null);

export const queueData$ = computed((get) => get(internalQueueData$));

const fetchQueueData$ = command(async ({ get, set }, _signal: AbortSignal) => {
  const client = get(zeroClient$)(zeroRunsQueueContract);
  const result = await client.getQueue();
  if (result.status !== 200) {
    throw new Error(`Failed to fetch queue (${result.status})`);
  }
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
    const result = await client.cancel({
      params: { id: runId },
    });
    signal.throwIfAborted();
    if (result.status !== 200) {
      throw new Error(`Failed to cancel run (${result.status})`);
    }
    // Refresh queue data after cancel
    await set(fetchQueueData$, signal);
  },
);
