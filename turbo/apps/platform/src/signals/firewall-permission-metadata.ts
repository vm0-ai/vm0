import { computed, type Computed } from "ccstate";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { accept } from "../lib/accept.ts";
import { zeroClient$ } from "./api-client.ts";
import { connectorsReloadVersion$ } from "./external/connectors.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";

interface FirewallPermissionMetadataParams {
  readonly connectorRef: string;
}

const FIREWALL_PERMISSION_METADATA_CACHE_LIMIT = 256;

function evictOldestCacheEntry<K, V>(cache: Map<K, V>): void {
  const oldest = cache.keys().next();
  if (!oldest.done) {
    cache.delete(oldest.value);
  }
}

function createFirewallPermissionMetadataFactory(): (
  params: FirewallPermissionMetadataParams,
) => Computed<Promise<PublicConnectorCatalogPermissionDetail | null>> {
  const cache = new Map<
    string,
    Computed<Promise<PublicConnectorCatalogPermissionDetail | null>>
  >();
  return (params) => {
    const key = params.connectorRef;
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(connectorsReloadVersion$);
      get(featureSwitch$);

      const createClient = get(zeroClient$);
      const client = createClient(zeroConnectorCatalogContract);
      const result = await accept(
        client.permissions({
          params: { connectorRef: key },
        }),
        [200, 404],
        { toast: false },
      );
      if (result.status === 404) {
        return null;
      }
      const { permissions } = result.body;
      if (permissions.connectorRef !== key) {
        throw new Error(
          `Permission metadata connectorRef mismatch: expected ${key}, got ${permissions.connectorRef}`,
        );
      }
      return permissions;
    });
    if (cache.size >= FIREWALL_PERMISSION_METADATA_CACHE_LIMIT) {
      evictOldestCacheEntry(cache);
    }
    cache.set(key, atom$);
    return atom$;
  };
}

export const firewallPermissionMetadataByConnector =
  createFirewallPermissionMetadataFactory();
