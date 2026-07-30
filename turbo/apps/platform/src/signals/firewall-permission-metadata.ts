import { computed, type Computed } from "ccstate";
import { connectorSlugSchema } from "@vm0/api-contracts/contracts/connector-identity";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { accept } from "../lib/accept.ts";
import { zeroClient$ } from "./api-client.ts";
import { connectorsReloadVersion$ } from "./external/connectors.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";

interface FirewallPermissionMetadataParams {
  readonly connectorSlug: string;
}

export function firewallPermissionMetadataByConnector(
  params: FirewallPermissionMetadataParams,
): Computed<Promise<PublicConnectorCatalogPermissionDetail | null>> {
  const key = params.connectorSlug;
  return computed(async (get) => {
    if (!connectorSlugSchema.safeParse(key).success) {
      return null;
    }
    get(connectorsReloadVersion$);
    get(featureSwitch$);

    const createClient = get(zeroClient$);
    const client = createClient(zeroConnectorCatalogContract);
    const result = await accept(
      client.permissions({
        params: { connectorSlug: key },
      }),
      [200, 404],
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
}
