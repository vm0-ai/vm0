import { computed } from "ccstate";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

/** Async computed — auto-fetches queue data when subscribed. */
export const queueData$ = computed(async (get) => {
  const client = get(zeroClient$)(zeroRunsQueueContract);
  const result = await accept(client.getQueue(), [200]);
  return result.body;
});
