import type { FirewallPolicyValue } from "../firewall-types";
import type { FirewallPermissionDetailMetadata } from "./types";

export interface FirewallMetadataPolicyOverlay {
  readonly permissionDefault?: FirewallPolicyValue;
  readonly permissionOverrides?: Readonly<Record<string, FirewallPolicyValue>>;
  readonly unknownPolicy?: FirewallPolicyValue;
}

export type FirewallMetadataPolicyListState = FirewallPolicyValue | "mixed";

export interface FirewallMetadataPolicyResolver {
  permission(name: string): FirewallPolicyValue;
  unknown(): FirewallPolicyValue;
  list(permissionNames: readonly string[]): FirewallMetadataPolicyListState;
  isPermissionOverridden(name: string): boolean;
  isUnknownOverridden(): boolean;
}

function buildMetadataOverrideLookup(
  metadata: FirewallPermissionDetailMetadata,
): ReadonlyMap<string, FirewallPolicyValue> {
  const overrides = metadata.defaultPolicy.permissionOverrides;
  const lookup = new Map<string, FirewallPolicyValue>();
  if (!overrides) {
    return lookup;
  }

  for (const permission of overrides.allow ?? []) {
    lookup.set(permission, "allow");
  }
  for (const permission of overrides.deny ?? []) {
    lookup.set(permission, "deny");
  }
  for (const permission of overrides.ask ?? []) {
    lookup.set(permission, "ask");
  }

  return lookup;
}

export function createFirewallMetadataPolicyResolver(
  metadata: FirewallPermissionDetailMetadata,
  overlay?: FirewallMetadataPolicyOverlay,
): FirewallMetadataPolicyResolver {
  const metadataOverrides = buildMetadataOverrideLookup(metadata);

  function metadataPermission(name: string): FirewallPolicyValue {
    return (
      metadataOverrides.get(name) ?? metadata.defaultPolicy.permissionDefault
    );
  }

  function permission(name: string): FirewallPolicyValue {
    // Permission validation is owned by callers; unknown endpoints use unknown().
    return (
      overlay?.permissionOverrides?.[name] ??
      overlay?.permissionDefault ??
      metadataPermission(name)
    );
  }

  return {
    permission,
    unknown: () => {
      return overlay?.unknownPolicy ?? metadata.defaultPolicy.unknownPolicy;
    },
    list: (permissionNames) => {
      let first: FirewallPolicyValue | null = null;
      for (const name of permissionNames) {
        const current = permission(name);
        if (first === null) {
          first = current;
          continue;
        }
        if (first !== current) {
          return "mixed";
        }
      }
      return first ?? "mixed";
    },
    isPermissionOverridden: (name) => {
      return permission(name) !== metadataPermission(name);
    },
    isUnknownOverridden: () => {
      return (
        (overlay?.unknownPolicy ?? metadata.defaultPolicy.unknownPolicy) !==
        metadata.defaultPolicy.unknownPolicy
      );
    },
  };
}
