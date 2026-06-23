import { computed, type Computed } from "ccstate";
import {
  isFirewallMetadataConnectorType,
  loadFirewallPermissionMetadata,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";

interface FirewallPermissionMetadataParams {
  readonly connectorType: string;
}

function createFirewallPermissionMetadataFactory(): (
  params: FirewallPermissionMetadataParams,
) => Computed<Promise<FirewallPermissionDetailMetadata | null>> {
  const cache = new Map<
    string,
    Computed<Promise<FirewallPermissionDetailMetadata | null>>
  >();
  return (params) => {
    const key = params.connectorType;
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async () => {
      if (!isFirewallMetadataConnectorType(params.connectorType)) {
        return null;
      }
      return await loadFirewallPermissionMetadata(params.connectorType);
    });
    cache.set(key, atom$);
    return atom$;
  };
}

export const firewallPermissionMetadataByConnector =
  createFirewallPermissionMetadataFactory();
