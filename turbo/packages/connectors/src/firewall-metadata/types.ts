import type { ConnectorType } from "../connectors";
import type { FirewallPolicyValue } from "../firewall-types";

export interface FirewallPermissionSummaryMetadata {
  readonly type: ConnectorType;
  readonly label: string;
  readonly hasPermissions: boolean;
  readonly permissionCount: number;
  readonly hasCategories: boolean;
  readonly hasDefaultPolicyOverrides: boolean;
}

export interface FirewallPermissionMetadataPermission {
  readonly name: string;
  readonly description?: string;
}

export interface FirewallPermissionCategoryMetadata {
  readonly categories: Readonly<Record<string, string>>;
  readonly displayOrder: readonly string[];
}

export type FirewallPermissionDefaultPolicyOverrides = Readonly<
  Partial<Record<FirewallPolicyValue, readonly string[]>>
>;

export interface FirewallPermissionDefaultPolicyMetadata {
  readonly permissionDefault: FirewallPolicyValue;
  readonly permissionOverrides?: FirewallPermissionDefaultPolicyOverrides;
  readonly unknownPolicy: FirewallPolicyValue;
}

export interface FirewallPermissionDetailMetadata {
  readonly type: ConnectorType;
  readonly label: string;
  readonly permissionCount: number;
  readonly permissions: readonly FirewallPermissionMetadataPermission[];
  readonly categories?: FirewallPermissionCategoryMetadata;
  readonly defaultPolicy: FirewallPermissionDefaultPolicyMetadata;
}
