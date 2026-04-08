import { command, state, computed } from "ccstate";
import { delay } from "signal-timers";
import { zeroRunsQueueContract, zeroRunsCancelContract } from "@vm0/core";
import { throwIfAbort } from "../utils.ts";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const POLL_INTERVAL = 5000;

const queueReload$ = state(0);

/** Async computed — auto-fetches queue data when subscribed. */
export const queueData$ = computed(async (get) => {
  get(queueReload$);
  const client = get(zeroClient$)(zeroRunsQueueContract);
  const result = await accept(client.getQueue(), [200], { toast: false });
  return result.body;
});

/** Bump reload counter to refetch queueData$. */
const reloadQueueData$ = command(({ set }) => {
  set(queueReload$, (n) => {
    return n + 1;
  });
});

export const startQueuePolling$ = command(
  async ({ set }, signal: AbortSignal) => {
    // Polling loop — initial data comes from queueData$ async computed
    while (!signal.aborted) {
      // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry
      try {
        await delay(POLL_INTERVAL, { signal });
        signal.throwIfAborted();
        set(reloadQueueData$);
      } catch (error) {
        throwIfAbort(error);
      }
    }
  },
);

export const cancelQueueRun$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroRunsCancelContract);
    await accept(client.cancel({ params: { id: runId } }), [200]);
    signal.throwIfAborted();
    set(reloadQueueData$);
  },
);
