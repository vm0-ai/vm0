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

export interface FirewallExecutionBaseUrlTemplateMetadata {
  readonly base: string;
  readonly credentialed: boolean;
}

export interface FirewallExecutionMetadata {
  readonly type: ConnectorType;
  readonly billable: boolean;
  readonly baseUrlVarNames: readonly string[];
  readonly baseUrlTemplates: readonly FirewallExecutionBaseUrlTemplateMetadata[];
  readonly secretPlaceholderNames: readonly string[];
  readonly placeholderValues: Readonly<Record<string, string>>;
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

export interface FirewallRoutingRouteMetadata {
  readonly permissionName: string;
  readonly rule: string;
}

export interface FirewallRoutingIndexApiMetadata {
  readonly base: string;
}

export interface FirewallRoutingIndexMetadata {
  readonly type: ConnectorType;
  readonly label: string;
  readonly apis: readonly FirewallRoutingIndexApiMetadata[];
}

export interface FirewallRoutingApiMetadata {
  readonly base: string;
  readonly routes: readonly FirewallRoutingRouteMetadata[];
}

export interface FirewallRoutingMetadata {
  readonly type: ConnectorType;
  readonly label: string;
  readonly apis: readonly FirewallRoutingApiMetadata[];
}
