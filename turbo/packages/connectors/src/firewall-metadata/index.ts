import { loadGeneratedFirewallPermissionMetadata } from "./permission-detail-loader.generated";
import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "./permission-summaries.generated";
import type {
  FirewallPermissionDetailMetadata,
  FirewallPermissionSummaryMetadata,
} from "./types";

export { FIREWALL_PERMISSION_METADATA_SUMMARIES };
export type {
  FirewallMetadataPermissionGroup,
  FirewallMetadataPolicyListState,
  FirewallMetadataPolicyOverlay,
  FirewallMetadataPolicyResolver,
  FirewallPermissionGrant,
  FirewallPermissionGrantAction,
  FirewallPermissionPolicyCategoryMetadata,
  FirewallPermissionPolicyDefaultMetadata,
  FirewallPermissionPolicyDefaultOverrides,
  FirewallPermissionPolicyMetadata,
  FirewallPermissionPolicyMetadataPermission,
} from "./policy";
export {
  createFirewallMetadataPolicyResolver,
  expandFirewallMetadataDefaultPolicy,
  findFirewallMetadataPermission,
  groupFirewallMetadataPermissionsByCategory,
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
} from "./policy";
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

export function hasFirewallMetadataPermissions(type: string): boolean {
  return getFirewallPermissionSummary(type)?.hasPermissions ?? false;
}

export async function loadFirewallPermissionMetadata(
  type: string,
): Promise<FirewallPermissionDetailMetadata | null> {
  if (!isFirewallMetadataConnectorType(type)) {
    return null;
  }
  return await loadGeneratedFirewallPermissionMetadata(type);
}
