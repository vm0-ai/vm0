import { command, state, computed } from "ccstate";
import { delay } from "signal-timers";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import {
  queueResponseSchema,
  type QueueResponse,
  type QueueEntry,
  type RunningTask,
} from "@vm0/core";

const POLL_INTERVAL = 5000;

export type { QueueEntry, RunningTask };
export type QueueData = QueueResponse;

const internalQueueData$ = state<QueueData | null>(null);

export const queueData$ = computed((get) => get(internalQueueData$));

const fetchQueueData$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/zero/runs/queue");
  if (!response.ok) {
    throw new Error(`Failed to fetch queue: ${response.statusText}`);
  }
  const data = queueResponseSchema.parse(await response.json());
  set(internalQueueData$, data);
});

export const startQueuePolling$ = command(
  async ({ set }, signal: AbortSignal) => {
    // Initial fetch
    await set(fetchQueueData$);
    signal.throwIfAborted();

    // Polling loop
    while (!signal.aborted) {
      try {
        await delay(POLL_INTERVAL, { signal });
        signal.throwIfAborted();
        await set(fetchQueueData$);
        signal.throwIfAborted();
      } catch (error) {
        throwIfAbort(error);
        // Swallow non-abort errors and continue polling
      }
    }
  },
);

export const cancelQueueRun$ = command(async ({ get, set }, runId: string) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn(`/api/zero/runs/${runId}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to cancel run: ${response.statusText}`);
  }
  // Refresh queue data after cancel
  await set(fetchQueueData$);
});
