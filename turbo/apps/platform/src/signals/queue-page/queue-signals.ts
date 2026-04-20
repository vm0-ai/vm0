import { command, state, computed } from "ccstate";
import { zeroRunsQueueContract, zeroRunsCancelContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setLoop } from "../utils.ts";

const POLL_INTERVAL = 5000;

const queueReload$ = state(0);

/** Async computed — auto-fetches queue data when subscribed. */
export const queueData$ = computed(async (get) => {
  get(queueReload$);
  const client = get(zeroClient$)(zeroRunsQueueContract);
  const result = await accept(client.getQueue(), [200]);
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
    await setLoop(
      () => {
        set(reloadQueueData$);
        return false;
      },
      POLL_INTERVAL,
      signal,
    );
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
