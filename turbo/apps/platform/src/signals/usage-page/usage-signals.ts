import { computed } from "ccstate";
import { zeroUsageMembersContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

/**
 * Async computed signal that fetches per-member usage data.
 * Throws on non-OK responses so useLoadable enters hasError state.
 */
export const usageMembersAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageMembersContract);
  const result = await client.get();
  if (result.status !== 200) {
    throw new Error(`Failed to fetch usage data: ${result.status}`);
  }
  return result.body;
});
