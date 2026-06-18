import type { FirewallPolicy, FirewallPolicyValue } from "../firewall-types";
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
