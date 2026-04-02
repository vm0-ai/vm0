import { command, computed, state } from "ccstate";
import { zeroAgentsByIdContract, type FirewallPolicies } from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { zeroClient$ } from "../../api-client.ts";
import { agentName$ } from "./agent-name.ts";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Firewall policies — fetched from zero agents endpoint
// ---------------------------------------------------------------------------

const internalFirewallPolicies$ = state<FirewallPolicies | null>(null);

export const zeroJobFirewallPolicies$ = computed((get) => {
  return get(internalFirewallPolicies$);
});

export const setZeroJobFirewallPolicies$ = command(
  ({ set }, policies: FirewallPolicies | null) => {
    set(internalFirewallPolicies$, policies);
  },
);

/** Reset firewall state to initial values. */
export const resetFirewallState$ = command(({ set }) => {
  set(internalFirewallPolicies$, null);
});

export const fetchZeroJobFirewallPolicies$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const name = get(agentName$);
    if (!name) {
      return;
    }

    try {
      const client = get(zeroClient$)(zeroAgentsByIdContract);
      const result = await client.get({ params: { id: name } });
      if (result.status !== 200) {
        L.warn(`Failed to fetch firewall policies (${result.status})`);
        return;
      }

      set(internalFirewallPolicies$, result.body.firewallPolicies ?? null);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch firewall policies:", error);
    }
  },
);
