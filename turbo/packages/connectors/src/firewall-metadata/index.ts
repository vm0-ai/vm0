import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicy,
  type FirewallPolicyValue,
} from "../firewall-types";
import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "./summary.generated";
import type {
  FirewallPermissionDetailMetadata,
  FirewallPermissionSummaryMetadata,
} from "./types";

export { FIREWALL_PERMISSION_METADATA_SUMMARIES };
export type {
  FirewallPermissionCategoryMetadata,
  FirewallPermissionDefaultPolicyMetadata,
  FirewallPermissionDefaultPolicyOverrides,
  FirewallPermissionDetailMetadata,
  FirewallPermissionMetadataPermission,
  FirewallPermissionSummaryMetadata,
} from "./types";

export type FirewallMetadataConnectorType =
  keyof typeof FIREWALL_PERMISSION_METADATA_SUMMARIES;

export interface FirewallMetadataPermissionGroup<T extends { name: string }> {
  readonly category: string;
  readonly permissions: T[];
}

export type FirewallPermissionGrantAction = Extract<
  FirewallPolicyValue,
  "allow" | "deny"
>;

export interface FirewallPermissionGrant {
  readonly connectorRef: string;
  readonly permission: string;
  readonly action: FirewallPermissionGrantAction;
}

export function isFirewallMetadataConnectorType(
  type: string,
): type is FirewallMetadataConnectorType {
  return Object.prototype.hasOwnProperty.call(
    FIREWALL_PERMISSION_METADATA_SUMMARIES,
    type,
  );
}

export function getFirewallPermissionSummary(
  type: string,
): FirewallPermissionSummaryMetadata | null {
  if (!isFirewallMetadataConnectorType(type)) {
    return null;
  }
  return FIREWALL_PERMISSION_METADATA_SUMMARIES[type];
}

export function hasFirewallMetadataPermissions(type: string): boolean {
  return getFirewallPermissionSummary(type)?.hasPermissions ?? false;
}

export async function loadFirewallPermissionMetadata(
  type: string,
): Promise<FirewallPermissionDetailMetadata | null> {
  if (!isFirewallMetadataConnectorType(type)) {
    return null;
  }
  const { loadGeneratedFirewallPermissionMetadata } =
    await import("./loader.generated");
  return await loadGeneratedFirewallPermissionMetadata(type);
}

export function expandFirewallMetadataDefaultPolicy(
  metadata: FirewallPermissionDetailMetadata,
): FirewallPolicy {
  const policies: Record<string, FirewallPolicyValue> = {};
  const overrides = metadata.defaultPolicy.permissionOverrides ?? {};
  const overrideLookup = new Map<string, FirewallPolicyValue>();

  for (const [policy, permissions] of Object.entries(overrides) as [
    FirewallPolicyValue,
    readonly string[],
  ][]) {
    for (const permission of permissions) {
      overrideLookup.set(permission, policy);
    }
  }

  for (const permission of metadata.permissions) {
    policies[permission.name] =
      overrideLookup.get(permission.name) ??
      metadata.defaultPolicy.permissionDefault;
  }

  return {
    policies,
    unknownPolicy: metadata.defaultPolicy.unknownPolicy,
  };
}

export function findFirewallMetadataPermission(
  metadata: FirewallPermissionDetailMetadata,
  name: string,
): FirewallPermissionDetailMetadata["permissions"][number] | null {
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
  metadata: FirewallPermissionDetailMetadata,
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
  metadata: readonly FirewallPermissionDetailMetadata[],
): FirewallPolicies | null {
  let resolved: FirewallPolicies | null = stored;
  for (const detail of metadata) {
    const defaults = expandFirewallMetadataDefaultPolicy(detail);
    const existing = resolved?.[detail.type];
    resolved = {
      ...resolved,
      [detail.type]: {
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
    const current = policies[grant.connectorRef] ?? { policies: {} };
    if (grant.permission === UNKNOWN_PERMISSION_GRANT) {
      policies[grant.connectorRef] = {
        ...current,
        unknownPolicy: grant.action,
      };
      continue;
    }
    current.policies[grant.permission] = grant.action;
    policies[grant.connectorRef] = current;
  }
  return Object.keys(policies).length > 0 ? policies : null;
}
