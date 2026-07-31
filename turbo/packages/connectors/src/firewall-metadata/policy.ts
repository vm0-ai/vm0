import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicy,
  type FirewallPolicyValue,
} from "../firewall-types";
import { createFirewallMetadataPolicyResolver } from "./policy-resolver";

export type {
  FirewallMetadataPolicyListState,
  FirewallMetadataPolicyOverlay,
  FirewallMetadataPolicyResolver,
} from "./policy-resolver";

export interface FirewallPermissionPolicyMetadataPermission {
  readonly name: string;
  readonly description?: string;
}

export interface FirewallPermissionPolicyCategoryMetadata {
  readonly categories: Readonly<Record<string, string>>;
  readonly displayOrder: readonly string[];
}

export type FirewallPermissionPolicyDefaultOverrides = Readonly<
  Partial<Record<FirewallPolicyValue, readonly string[]>>
>;

export interface FirewallPermissionPolicyDefaultMetadata {
  readonly permissionDefault: FirewallPolicyValue;
  readonly permissionOverrides?: FirewallPermissionPolicyDefaultOverrides;
  readonly unknownPolicy: FirewallPolicyValue;
}

interface FirewallPermissionPolicyMetadataBase {
  readonly label: string;
  readonly permissionCount: number;
  readonly permissions: readonly FirewallPermissionPolicyMetadataPermission[];
  readonly categories?: FirewallPermissionPolicyCategoryMetadata | null;
  readonly defaultPolicy: FirewallPermissionPolicyDefaultMetadata;
}

export interface FirewallPermissionPolicyMetadata extends FirewallPermissionPolicyMetadataBase {
  readonly connectorSlug: string;
}

export interface FirewallMetadataPermissionGroup<T extends { name: string }> {
  readonly category: string;
  readonly permissions: T[];
}

export type FirewallPermissionGrantAction = Extract<
  FirewallPolicyValue,
  "allow" | "deny"
>;

export interface FirewallPermissionGrant {
  readonly connectorSlug: string;
  readonly permission: string;
  readonly action: FirewallPermissionGrantAction;
}

export { createFirewallMetadataPolicyResolver };

export function expandFirewallMetadataDefaultPolicy(
  metadata: FirewallPermissionPolicyMetadata,
): FirewallPolicy {
  const resolver = createFirewallMetadataPolicyResolver(metadata);
  const policies: Record<string, FirewallPolicyValue> = {};

  for (const permission of metadata.permissions) {
    policies[permission.name] = resolver.permission(permission.name);
  }

  return {
    policies,
    unknownPolicy: resolver.unknown(),
  };
}

export function findFirewallMetadataPermission(
  metadata: FirewallPermissionPolicyMetadata,
  name: string,
): FirewallPermissionPolicyMetadata["permissions"][number] | null {
  return (
    metadata.permissions.find((permission) => {
      return permission.name === name;
    }) ?? null
  );
}

export function groupFirewallMetadataPermissionsByCategory<
  T extends { name: string },
>(
  permissions: readonly T[],
  metadata: FirewallPermissionPolicyMetadata,
): FirewallMetadataPermissionGroup<T>[] | null {
  if (!metadata.categories) {
    return null;
  }

  const grouped = new Map<string, T[]>();
  for (const category of metadata.categories.displayOrder) {
    grouped.set(category, []);
  }

  for (const permission of permissions) {
    const category = metadata.categories.categories[permission.name];
    if (!category) {
      continue;
    }
    grouped.get(category)?.push(permission);
  }

  return [...grouped.entries()]
    .filter(([, groupPermissions]) => {
      return groupPermissions.length > 0;
    })
    .map(([category, groupPermissions]) => {
      return { category, permissions: groupPermissions };
    });
}

export function resolveFirewallMetadataPolicies(
  stored: FirewallPolicies | null,
  metadata: readonly FirewallPermissionPolicyMetadata[],
): FirewallPolicies | null {
  let resolved: FirewallPolicies | null = stored;
  for (const detail of metadata) {
    const defaults = expandFirewallMetadataDefaultPolicy(detail);
    const existing = resolved?.[detail.connectorSlug];
    resolved = {
      ...resolved,
      [detail.connectorSlug]: {
        policies: { ...defaults.policies, ...existing?.policies },
        ...(existing?.unknownPolicy !== undefined
          ? { unknownPolicy: existing.unknownPolicy }
          : { unknownPolicy: defaults.unknownPolicy }),
      },
    };
  }
  return resolved;
}

export function permissionGrantsToFirewallPolicies(
  grants: readonly FirewallPermissionGrant[],
): FirewallPolicies | null {
  const policies: FirewallPolicies = {};
  for (const grant of grants) {
    const current = policies[grant.connectorSlug] ?? { policies: {} };
    if (grant.permission === UNKNOWN_PERMISSION_GRANT) {
      policies[grant.connectorSlug] = {
        ...current,
        unknownPolicy: grant.action,
      };
      continue;
    }
    current.policies[grant.permission] = grant.action;
    policies[grant.connectorSlug] = current;
  }
  return Object.keys(policies).length > 0 ? policies : null;
}
