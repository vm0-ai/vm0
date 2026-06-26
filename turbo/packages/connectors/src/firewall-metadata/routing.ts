import { FIREWALL_ROUTING_METADATA_INDEX } from "./routing-index.generated";
import { loadGeneratedFirewallRoutingMetadata } from "./routing-loader.generated";
import type {
  FirewallRoutingIndexMetadata,
  FirewallRoutingMetadata,
} from "./types";

export { FIREWALL_ROUTING_METADATA_INDEX };
export type {
  FirewallRoutingApiMetadata,
  FirewallRoutingIndexApiMetadata,
  FirewallRoutingIndexMetadata,
  FirewallRoutingMetadata,
  FirewallRoutingRouteMetadata,
} from "./types";

export type FirewallRoutingMetadataConnectorType =
  keyof typeof FIREWALL_ROUTING_METADATA_INDEX;

export const FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES = Object.keys(
  FIREWALL_ROUTING_METADATA_INDEX,
) as FirewallRoutingMetadataConnectorType[];

export function isFirewallRoutingMetadataConnectorType(
  type: string,
): type is FirewallRoutingMetadataConnectorType {
  return Object.prototype.hasOwnProperty.call(
    FIREWALL_ROUTING_METADATA_INDEX,
    type,
  );
}

export function getFirewallRoutingIndexMetadata(
  type: FirewallRoutingMetadataConnectorType,
): FirewallRoutingIndexMetadata;
export function getFirewallRoutingIndexMetadata(
  type: string,
): FirewallRoutingIndexMetadata | null;
export function getFirewallRoutingIndexMetadata(
  type: string,
): FirewallRoutingIndexMetadata | null {
  if (!isFirewallRoutingMetadataConnectorType(type)) {
    return null;
  }
  return FIREWALL_ROUTING_METADATA_INDEX[type];
}

export function loadFirewallRoutingMetadata(
  type: FirewallRoutingMetadataConnectorType,
): Promise<FirewallRoutingMetadata>;
export function loadFirewallRoutingMetadata(
  type: string,
): Promise<FirewallRoutingMetadata | null>;
export async function loadFirewallRoutingMetadata(
  type: string,
): Promise<FirewallRoutingMetadata | null> {
  if (!isFirewallRoutingMetadataConnectorType(type)) {
    return null;
  }
  return await loadGeneratedFirewallRoutingMetadata(type);
}
