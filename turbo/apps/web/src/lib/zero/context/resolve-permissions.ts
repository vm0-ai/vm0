import {
  resolveFirewallBaseUrlVars,
  type Firewalls,
  type ExpandedFirewallConfig,
  type FirewallPolicies,
  type GrantedPermissions,
} from "@vm0/core";

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
  grantedPermissions: GrantedPermissions;
}

/**
 * Merge model provider and connector permissions into a single manifest.
 * Returns full (unfiltered) firewalls + per-ref grantedPermissions.
 */
export function mergePermissions(
  modelProviderFirewall: Firewalls[number] | null | undefined,
  connectorFirewalls: ExpandedFirewallConfig[],
  permissionPolicies?: FirewallPolicies,
  vars?: Record<string, string>,
  allowUnknownEndpoints?: Record<string, boolean>,
): MergedPermissions | undefined {
  const { firewalls: connectorResults, grantedPermissions } =
    applyConnectorPolicies(
      connectorFirewalls,
      permissionPolicies,
      allowUnknownEndpoints,
    );

  // Model provider firewalls — always fully permissive, grant all permissions
  const autoConfigs = modelProviderFirewall ? [modelProviderFirewall] : [];
  if (modelProviderFirewall) {
    grantedPermissions[modelProviderFirewall.ref] = {
      allow: collectPermissionNames(modelProviderFirewall.apis),
      allowUnknown: true,
    };
  }

  const allConfigs = [...autoConfigs, ...connectorResults];
  if (allConfigs.length === 0) return undefined;
  return {
    firewalls: resolveFirewallBaseUrlVars(allConfigs, vars),
    grantedPermissions,
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
  grantedPermissions: GrantedPermissions;
}

/**
 * Build full (unfiltered) firewall configs + per-ref grantedPermissions.
 *
 * Firewalls now carry ALL permissions (no filtering). The grantedPermissions
 * map tells the proxy which permissions the user authorized and whether
 * unknown endpoints (not matching any rule) should be allowed.
 */
export function applyConnectorPolicies(
  connectorFirewalls: ExpandedFirewallConfig[],
  policies?: FirewallPolicies,
  allowUnknownEndpoints?: Record<string, boolean>,
): ConnectorPoliciesResult {
  const firewalls: Firewalls = [];
  const grantedPermissions: GrantedPermissions = {};

  for (const fw of connectorFirewalls) {
    const refPolicies = policies?.[fw.ref];

    // Build full (unfiltered) firewall entry — pass permissions as-is
    const apis = fw.apis.map((api) => {
      return {
        base: api.base,
        auth: api.auth,
        permissions: api.permissions ?? [],
      };
    });

    firewalls.push({ name: fw.name, ref: fw.ref, apis });

    // Build grantedPermissions for this ref — always explicit, never omit.
    const allowUnknown = allowUnknownEndpoints?.[fw.ref] ?? true;
    const allPermNames = collectPermissionNames(fw.apis);
    if (!refPolicies) {
      // No policies configured → all granted
      grantedPermissions[fw.ref] = { allow: allPermNames, allowUnknown };
    } else {
      const granted = allPermNames.filter((name) => {
        return refPolicies[name] === "allow";
      });
      grantedPermissions[fw.ref] = { allow: granted, allowUnknown };
    }
  }

  return { firewalls, grantedPermissions };
}
