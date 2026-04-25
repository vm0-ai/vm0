import { command } from "ccstate";
import type { ConnectorType } from "@vm0/api-contracts/contracts/connectors";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/api-contracts/firewalls";
import type {
  FirewallPolicies,
  FirewallPolicyValue,
} from "@vm0/api-contracts/contracts/firewalls";
import { zeroAgentPermissionPoliciesContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";

/** Check if a connector has any permissions defined. */
export function hasConnectorPermissions(type: ConnectorType): boolean {
  if (!isFirewallConnectorType(type)) {
    return false;
  }
  const config = getConnectorFirewall(type);
  return config.apis.some((api) => {
    return api.permissions && api.permissions.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Permission policy: allow | deny | ask
// ---------------------------------------------------------------------------

export type PermissionPolicy = FirewallPolicyValue;

/**
 * Persist permission policies to the backend for an agent.
 */
export const savePermissionPolicies$ = command(
  async (
    { get },
    agentName: string,
    policies: FirewallPolicies,
    signal: AbortSignal,
  ): Promise<FirewallPolicies | null> => {
    const client = get(zeroClient$)(zeroAgentPermissionPoliciesContract);
    const result = await accept(
      client.update({ body: { agentId: agentName, policies } }),
      [200],
    );

    signal.throwIfAborted();
    return result.body.permissionPolicies ?? null;
  },
);
