import { computed } from "ccstate";
import { zeroUsageMembersContract } from "@vm0/core/contracts/zero-usage";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

// --- Existing member usage signal ---

export const usageMembersAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageMembersContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});
