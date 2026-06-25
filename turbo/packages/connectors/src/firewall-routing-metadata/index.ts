import {
  FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES,
  hasGeneratedFirewallRoutingMetadata,
  loadGeneratedFirewallRoutingMetadata,
  type GeneratedFirewallRoutingMetadataConnectorType,
} from "./loader.generated";
import type { FirewallRoutingMetadata } from "./types";

export { FIREWALL_ROUTING_METADATA_CONNECTOR_TYPES };
export type FirewallRoutingMetadataConnectorType =
  GeneratedFirewallRoutingMetadataConnectorType;
export type {
  FirewallRoutingApiMetadata,
  FirewallRoutingMetadata,
  FirewallRoutingPermissionMetadata,
} from "./types";

const routingMetadataCache = new Map<
  FirewallRoutingMetadataConnectorType,
  Promise<FirewallRoutingMetadata>
>();

export function isFirewallRoutingMetadataConnectorType(
  type: string,
): type is FirewallRoutingMetadataConnectorType {
  return hasGeneratedFirewallRoutingMetadata(type);
}

async function loadRequiredFirewallRoutingMetadata(
  type: FirewallRoutingMetadataConnectorType,
): Promise<FirewallRoutingMetadata> {
  const metadata = await loadGeneratedFirewallRoutingMetadata(type);
  if (metadata.type !== type) {
    throw new Error(
      `Mismatched firewall routing metadata: requested ${type}, got ${metadata.type}`,
    );
  }
  return metadata;
}

export async function loadFirewallRoutingMetadata(
  type: FirewallRoutingMetadataConnectorType,
): Promise<FirewallRoutingMetadata>;
export async function loadFirewallRoutingMetadata(
  type: string,
): Promise<FirewallRoutingMetadata | null>;
export async function loadFirewallRoutingMetadata(
  type: string,
): Promise<FirewallRoutingMetadata | null> {
  if (!isFirewallRoutingMetadataConnectorType(type)) {
    return null;
  }

  const cached = routingMetadataCache.get(type);
  if (cached) {
    return await cached;
  }

  const load = loadRequiredFirewallRoutingMetadata(type).catch(
    (error: unknown) => {
      routingMetadataCache.delete(type);
      throw error;
    },
  );
  routingMetadataCache.set(type, load);
  return await load;
}
