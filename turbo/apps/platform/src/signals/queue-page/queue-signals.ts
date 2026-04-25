import { command, state, computed } from "ccstate";
import {
  zeroRunsQueueContract,
  zeroRunsCancelContract,
} from "@vm0/core/contracts/zero-runs";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

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

/**
 * Subscribe to org-wide queue changes via Ably. The queue page daemon
 * runs for the lifetime of the page; the loop body never returns true.
 * Each `queue:changed` event refetches `queueData$`.
 */
export const startQueuePolling$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onQueueChanged$ = command(({ set }) => {
      set(reloadQueueData$);
      return false;
    });

    await set(setAblyLoop$, "queue:changed", onQueueChanged$, signal);
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
