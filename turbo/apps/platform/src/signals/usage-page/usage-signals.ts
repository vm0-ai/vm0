import { computed } from "ccstate";
import { zeroUsageMembersContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

/**
 * Async computed signal that fetches per-member usage data.
 * Throws on non-OK responses so useLoadable enters hasError state.
 */
export const usageMembersAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageMembersContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});
