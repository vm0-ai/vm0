import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicy,
  type FirewallPolicyValue,
} from "../firewall-types";
import {
  createFirewallMetadataPolicyResolver,
  type FirewallMetadataPolicyOverlay,
} from "./policy-resolver";
import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "./summary.generated";
import type {
  FirewallPermissionDetailMetadata,
  FirewallPermissionSummaryMetadata,
} from "./types";

export { FIREWALL_PERMISSION_METADATA_SUMMARIES };
export { createFirewallMetadataPolicyResolver };
export type {
  FirewallMetadataPolicyListState,
  FirewallMetadataPolicyOverlay,
  FirewallMetadataPolicyResolver,
} from "./policy-resolver";
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

export type CompactFirewallPermissionGrantTarget =
  | { readonly kind: "connector-default" }
  | { readonly kind: "permission"; readonly permission: string }
  | { readonly kind: "unknown-endpoint" };

export interface CompactFirewallPermissionGrant {
  readonly connectorRef: string;
  readonly target: CompactFirewallPermissionGrantTarget;
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

export function compactPermissionGrantsToFirewallMetadataOverlay(
  grants: readonly CompactFirewallPermissionGrant[],
  connectorRef: string,
): FirewallMetadataPolicyOverlay | undefined {
  let permissionDefault: FirewallPolicyValue | undefined;
  let unknownPolicy: FirewallPolicyValue | undefined;
  const permissionOverrides: Record<string, FirewallPolicyValue> = {};

  for (const grant of grants) {
    if (grant.connectorRef !== connectorRef) {
      continue;
    }
    switch (grant.target.kind) {
      case "connector-default": {
        permissionDefault = grant.action;
        break;
      }
      case "permission": {
        permissionOverrides[grant.target.permission] = grant.action;
        break;
      }
      case "unknown-endpoint": {
        unknownPolicy = grant.action;
        break;
      }
    }
  }

  const hasPermissionOverrides = Object.keys(permissionOverrides).length > 0;
  if (
    permissionDefault === undefined &&
    unknownPolicy === undefined &&
    !hasPermissionOverrides
  ) {
    return undefined;
  }

  return {
    ...(permissionDefault !== undefined ? { permissionDefault } : {}),
    ...(hasPermissionOverrides ? { permissionOverrides } : {}),
    ...(unknownPolicy !== undefined ? { unknownPolicy } : {}),
  };
}

export function resolveCompactFirewallMetadataPolicies(
  grants: readonly CompactFirewallPermissionGrant[],
  metadata: readonly FirewallPermissionDetailMetadata[],
): FirewallPolicies | null {
  let resolved: FirewallPolicies | null = null;
  for (const detail of metadata) {
    const overlay = compactPermissionGrantsToFirewallMetadataOverlay(
      grants,
      detail.type,
    );
    if (!overlay) {
      continue;
    }
    const resolver = createFirewallMetadataPolicyResolver(detail, overlay);
    const policies: Record<string, FirewallPolicyValue> = {};
    for (const permission of detail.permissions) {
      policies[permission.name] = resolver.permission(permission.name);
    }
    resolved = {
      ...(resolved ?? {}),
      [detail.type]: {
        policies,
        unknownPolicy: resolver.unknown(),
      },
    };
  }
  return resolved;
}
