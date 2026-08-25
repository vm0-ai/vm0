import type {
  FirewallPolicy,
  NetworkPolicy,
} from "@okouai/connectors/firewall-types";

import type { ConnectorServerFirewallPermissionIndex } from "./connector-server-firewall-catalog.service";

export function defaultFirewallPolicyForPermissionIndex(
  index: ConnectorServerFirewallPermissionIndex,
): FirewallPolicy {
  return {
    policies: { ...index.defaultPermissionPolicies },
    unknownPolicy: index.defaultPolicy.unknownPolicy,
  };
}

export function networkPolicyForFirewallPolicy(
  permissionNames: readonly string[],
  policy: FirewallPolicy,
): NetworkPolicy {
  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  for (const name of permissionNames) {
    const value = policy.policies[name];
    if (value === "allow") {
      allow.push(name);
    } else if (value === "deny") {
      deny.push(name);
    } else if (value === "ask") {
      ask.push(name);
    }
  }

  return {
    allow,
    deny,
    ask,
    unknownPolicy: policy.unknownPolicy ?? "allow",
  };
}
