import {
  resolveFirewallBaseUrlVars,
  type Firewalls,
  type ExpandedFirewallConfig,
  type FirewallPolicies,
  type NetworkPolicies,
} from "@vm0/core/contracts/firewalls";

/**
 * Filter secretConnectorMap by removing keys that are overridden by
 * higher-priority secret sources (CLI, DB, model-provider).  Connector's own
 * injected env vars are NOT overrides — they come from the connector itself.
 *
 * @internal Exported for testing.
 */
export function filterSecretConnectorMap(
  secretConnectorMap: Record<string, string> | undefined,
  overrideSources: (Record<string, string> | undefined)[],
): Record<string, string> | undefined {
  if (!secretConnectorMap) return undefined;
  const overrideKeys = new Set(
    overrideSources.flatMap((s) => {
      return s ? Object.keys(s) : [];
    }),
  );
  const filtered = Object.fromEntries(
    Object.entries(secretConnectorMap).filter(([key]) => {
      return !overrideKeys.has(key);
    }),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

interface MergedPermissions {
  firewalls: Firewalls;
  networkPolicies: NetworkPolicies;
}

/**
 * Merge model provider and connector permissions into a single manifest.
 * Returns full (unfiltered) firewalls + per-ref networkPolicies.
 */
export function mergePermissions(
  modelProviderFirewall: Firewalls[number] | null | undefined,
  connectorFirewalls: ExpandedFirewallConfig[],
  permissionPolicies?: FirewallPolicies,
  vars?: Record<string, string>,
): MergedPermissions | undefined {
  const { firewalls: connectorResults, networkPolicies } =
    applyConnectorPolicies(connectorFirewalls, permissionPolicies);

  // Model provider firewalls — always fully permissive, grant all permissions
  const autoConfigs = modelProviderFirewall ? [modelProviderFirewall] : [];
  if (modelProviderFirewall) {
    networkPolicies[modelProviderFirewall.name] = {
      allow: collectPermissionNames(modelProviderFirewall.apis),
      deny: [],
      ask: [],
      unknownPolicy: "allow",
    };
  }

  const allConfigs = [...autoConfigs, ...connectorResults];
  if (allConfigs.length === 0) return undefined;
  return {
    firewalls: resolveFirewallBaseUrlVars(allConfigs, vars),
    networkPolicies,
  };
}

/** Collect all unique permission names from a firewall's APIs. */
function collectPermissionNames(
  apis: { permissions?: { name: string }[] }[],
): string[] {
  const names: string[] = [];
  for (const api of apis) {
    for (const perm of api.permissions ?? []) {
      names.push(perm.name);
    }
  }
  return [...new Set(names)];
}

interface ConnectorPoliciesResult {
  firewalls: Firewalls;
  networkPolicies: NetworkPolicies;
}

/**
 * Build full (unfiltered) firewall configs + per-firewall networkPolicies.
 *
 * Firewalls now carry ALL permissions (no filtering). The networkPolicies
 * map (keyed by firewall name) tells the proxy which permissions the user
 * authorized and whether unknown endpoints (not matching any rule) should
 * be allowed.
 */
export function applyConnectorPolicies(
  connectorFirewalls: ExpandedFirewallConfig[],
  policies?: FirewallPolicies,
): ConnectorPoliciesResult {
  const firewalls: Firewalls = [];
  const networkPolicies: NetworkPolicies = {};

  for (const fw of connectorFirewalls) {
    const firewallPolicy = policies?.[fw.name];

    // Build full (unfiltered) firewall entry — pass permissions as-is
    const apis = fw.apis.map((api) => {
      return {
        base: api.base,
        auth: api.auth,
        permissions: api.permissions ?? [],
      };
    });

    firewalls.push({ name: fw.name, apis });

    // Build networkPolicies for this firewall — always explicit, never omit.
    const unknownPolicy = firewallPolicy?.unknownPolicy ?? "allow";
    const allPermNames = collectPermissionNames(fw.apis);
    if (!firewallPolicy) {
      // No policies configured → all granted, none denied
      networkPolicies[fw.name] = {
        allow: allPermNames,
        deny: [],
        ask: [],
        unknownPolicy,
      };
    } else {
      const allow: string[] = [];
      const deny: string[] = [];
      const ask: string[] = [];
      for (const name of allPermNames) {
        const policy = firewallPolicy.policies[name];
        if (policy === "allow") {
          allow.push(name);
        } else if (policy === "deny") {
          deny.push(name);
        } else if (policy === "ask") {
          ask.push(name);
        }
      }
      networkPolicies[fw.name] = { allow, deny, ask, unknownPolicy };
    }
  }

  return { firewalls, networkPolicies };
}
