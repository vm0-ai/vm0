import type { ConnectorType } from "../connectors";

export interface FirewallRoutingPermissionMetadata {
  readonly name: string;
  readonly rules: readonly string[];
}

export interface FirewallRoutingApiMetadata {
  readonly base: string;
  readonly permissions: readonly FirewallRoutingPermissionMetadata[];
}

export interface FirewallRoutingMetadata {
  readonly type: ConnectorType;
  readonly label: string;
  readonly apis: readonly FirewallRoutingApiMetadata[];
}
