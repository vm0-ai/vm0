import type { ConnectorAuthMethodId } from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";

import { getConnectorStatusDirectConnectMethod } from "../../../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export interface ConnectorConnectHandlers {
  readonly openModal: () => void;
  readonly connectBrowserAuth: (
    authMethod: PublicConnectorCatalogAuthMethodDetail,
  ) => Promise<unknown>;
  readonly connectNoAuth: (
    authMethod: ConnectorAuthMethodId,
  ) => Promise<unknown>;
}

interface LaunchConnectorConnectOptions extends ConnectorConnectHandlers {
  readonly connector: PublicConnectorCatalogStatusItem;
}

export function launchConnectorConnect({
  connector,
  openModal,
  connectBrowserAuth,
  connectNoAuth,
}: LaunchConnectorConnectOptions): void {
  const directConnectMethod = getConnectorStatusDirectConnectMethod(connector);
  if (!directConnectMethod) {
    openModal();
    return;
  }
  if (directConnectMethod.kind === "browser-auth") {
    detach(
      connectBrowserAuth(directConnectMethod.authMethod),
      Reason.DomCallback,
    );
    return;
  }

  detach(connectNoAuth(directConnectMethod.authMethod), Reason.DomCallback);
}
