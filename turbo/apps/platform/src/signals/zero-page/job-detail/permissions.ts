import { computed } from "ccstate";
import type { FirewallPolicies } from "@vm0/core";
import { zeroJobDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Permission policies — derived from agent detail (no separate API call)
// ---------------------------------------------------------------------------

export const zeroJobPermissionPolicies$ = computed(
  async (get): Promise<FirewallPolicies | null> => {
    const detail = await get(zeroJobDetail$);
    return detail?.permissionPolicies ?? null;
  },
);
