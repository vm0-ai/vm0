import { computed } from "ccstate";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";
import { agentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Permission policies — derived from agent detail (no separate API call)
// ---------------------------------------------------------------------------

export const agentPermissionPolicies$ = computed(
  async (get): Promise<FirewallPolicies | null> => {
    const detail = await get(agentDetail$);
    return detail?.permissionPolicies ?? null;
  },
);
