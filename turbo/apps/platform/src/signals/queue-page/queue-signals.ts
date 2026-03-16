import { command, state, computed } from "ccstate";
import { delay } from "signal-timers";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";

const POLL_INTERVAL = 5000;

export interface QueueEntry {
  position: number;
  agentName: string;
  userEmail: string;
  createdAt: string;
  isOwner: boolean;
  runId: string | null;
  prompt: string | null;
  triggerSource: "schedule" | "chat" | "api" | null;
  sessionLink: string | null;
}

export interface RunningTask {
  runId: string | null;
  agentName: string;
  userEmail: string;
  startedAt: string | null;
  isOwner: boolean;
}

interface ConcurrencyInfo {
  tier: string;
  limit: number;
  active: number;
  available: number;
}

export interface QueueData {
  concurrency: ConcurrencyInfo;
  queue: QueueEntry[];
  runningTasks: RunningTask[];
  estimatedTimePerRun: number | null;
}

const internalQueueData$ = state<QueueData | null>(null);

export const queueData$ = computed((get) => get(internalQueueData$));

const fetchQueueData$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/agent/runs/queue");
  if (!response.ok) {
    throw new Error(`Failed to fetch queue: ${response.statusText}`);
  }
  const data = (await response.json()) as QueueData;
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
