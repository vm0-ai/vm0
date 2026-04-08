import {
  resolveFirewallBaseUrlVars,
  type Firewalls,
  type ExpandedFirewallConfig,
  type FirewallPolicies,
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

/**
 * Merge model provider and connector permissions into a single manifest.
 * Compose content no longer stores firewalls — all configs are runtime-injected.
 */
export function mergePermissions(
  modelProviderFirewall: Firewalls[number] | null | undefined,
  connectorFirewalls: ExpandedFirewallConfig[],
  permissionPolicies?: FirewallPolicies,
  vars?: Record<string, string>,
): Firewalls | undefined {
  const autoConfigs = modelProviderFirewall ? [modelProviderFirewall] : [];
  const policyConfigs = applyConnectorPolicies(
    connectorFirewalls,
    permissionPolicies,
  );
  const allConfigs = [...autoConfigs, ...policyConfigs];
  if (allConfigs.length === 0) return undefined;
  return resolveFirewallBaseUrlVars(allConfigs, vars);
}

/** Unrestricted permission — allows all endpoints through the proxy. */
export const UNRESTRICTED_PERMISSION = {
  name: "unrestricted",
  description: "Allow all endpoints",
  rules: ["ANY /{path*}"],
};

/**
 * Apply firewall policies to connector firewall configs.
 *
 * For each connector firewall:
 * - If the ref has explicit policies, only "allow" permissions are included.
 * - If the ref has no policies, all defined permissions are included as-is
 *   (treated as all-allow). If no permissions are defined, an "unrestricted"
 *   permission is added to allow all endpoints through the proxy.
 * - If all permissions are denied, the entry is excluded entirely.
 */
export function applyConnectorPolicies(
  connectorFirewalls: ExpandedFirewallConfig[],
  policies?: FirewallPolicies,
): Firewalls {
  const result: Firewalls = [];

  for (const fw of connectorFirewalls) {
    const refPolicies = policies?.[fw.ref];

    // If the firewall defines no permissions on any api, treat as
    // unrestricted (no granular permission control).
    const hasPermissions = fw.apis.some((api) => {
      return api.permissions && api.permissions.length > 0;
    });

    const apis = fw.apis.map((api) => {
      if (!hasPermissions) {
        return {
          base: api.base,
          auth: api.auth,
          permissions: [UNRESTRICTED_PERMISSION],
        };
      }

      if (!refPolicies) {
        // No policies configured — include all defined permissions.
        return {
          base: api.base,
          auth: api.auth,
          permissions: api.permissions ?? [],
        };
      }

      const allowed = api.permissions?.filter((perm) => {
        return refPolicies[perm.name] === "allow";
      });

      return {
        base: api.base,
        auth: api.auth,
        permissions: allowed ?? [],
      };
    });

    result.push({ name: fw.name, ref: fw.ref, apis });
  }

  return result;
}
