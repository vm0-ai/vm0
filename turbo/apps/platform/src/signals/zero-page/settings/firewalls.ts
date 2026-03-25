import { command } from "ccstate";
import {
  zeroAgentFirewallPoliciesContract,
  type ConnectorType,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";

/**
 * Maps platform connector types to their firewall ref name(s) in builtinFirewalls.
 * Only includes connectors that have builtin firewall configs available.
 */
const FIREWALL_CONNECTOR_MAP: Readonly<
  Partial<Record<ConnectorType, readonly string[]>>
> = {
  github: ["github"],
  slack: ["slack"],
  gmail: ["gmail"],
  "google-sheets": ["google-sheets"],
  "google-docs": ["google-docs"],
  "google-drive": ["google-drive"],
  "google-calendar": ["google-calendar"],
  atlassian: ["jira", "confluence"],
} as const;

/** Check if a connector type has firewall config(s) available. */
export function hasFirewallConfig(type: ConnectorType): boolean {
  return type in FIREWALL_CONNECTOR_MAP;
}

/** Get the firewall ref names for a connector type. */
export function getFirewallRefs(type: ConnectorType): string[] {
  return [...(FIREWALL_CONNECTOR_MAP[type] ?? [])];
}

// ---------------------------------------------------------------------------
// Permission policy: allow | deny | ask
// ---------------------------------------------------------------------------

export type PermissionPolicy = FirewallPolicyValue;

/**
 * Persist firewall policies to the backend for an agent.
 */
export const saveFirewallPolicies$ = command(
  async (
    { get },
    agentName: string,
    policies: FirewallPolicies,
  ): Promise<FirewallPolicies | null> => {
    const client = get(zeroClient$)(zeroAgentFirewallPoliciesContract);
    const result = await client.update({
      body: { agentId: agentName, policies },
    });

    if (result.status !== 200) {
      const detail =
        result.status === 400 ||
        result.status === 401 ||
        result.status === 403 ||
        result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Save failed: ${detail}`);
    }

    return result.body.firewallPolicies ?? null;
  },
);
