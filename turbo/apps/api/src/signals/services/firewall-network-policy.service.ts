import type { FirewallPermissionIndex } from "@vm0/connectors/firewall-metadata/server";
import type {
  FirewallPolicy,
  NetworkPolicy,
} from "@vm0/connectors/firewall-types";

export function defaultFirewallPolicyForPermissionIndex(
  index: FirewallPermissionIndex,
): FirewallPolicy {
  const policies: FirewallPolicy["policies"] = {};
  for (const name of index.permissionNames) {
    policies[name] = index.policyResolver.permission(name);
  }
  return {
    policies,
    unknownPolicy: index.policyResolver.unknown(),
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
