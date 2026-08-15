import { command, computed, state } from "ccstate";
import { zeroRunsQueueContract } from "@okouai/api-contracts/contracts/zero-runs";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const queueDataReload$ = state(0);

/** Async computed — auto-fetches queue data when subscribed. */
export const queueData$ = computed(async (get) => {
  get(queueDataReload$);
  const client = get(zeroClient$)(zeroRunsQueueContract);
  const result = await accept(client.getQueue(), [200]);
  return result.body;
});

export const reloadQueueData$ = command(({ set }) => {
  set(queueDataReload$, (value) => {
    return value + 1;
  });
});
