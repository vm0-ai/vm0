import type { ConnectorAuthMethodId } from "@vm0/api-contracts/contracts/connector-identity";

import {
  getConnectorStatusConnectLaunchMode,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  type ConnectorStatusAuthMethodDetail,
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

interface LaunchConnectorConnectOptions {
  readonly connector: ConnectorTypeWithStatus;
  readonly openModal: () => void;
  readonly connectBrowserAuth: (
    authMethod: ConnectorStatusAuthMethodDetail,
  ) => Promise<unknown>;
  readonly connectNoAuth: (
    authMethod: ConnectorAuthMethodId,
  ) => Promise<unknown>;
}

export function launchConnectorConnect({
  connector,
  openModal,
  connectBrowserAuth,
  connectNoAuth,
}: LaunchConnectorConnectOptions): void {
  const launchMode = getConnectorStatusConnectLaunchMode(connector);
  if (launchMode === "modal") {
    openModal();
    return;
  }
  if (launchMode === "browser-auth") {
    const authMethod = getOnlyAvailableStatusBrowserAuthMethodDetail(connector);
    if (!authMethod) {
      openModal();
      return;
    }
    detach(connectBrowserAuth(authMethod), Reason.DomCallback);
    return;
  }

  const authMethod = getOnlyAvailableStatusNoAuthMethod(connector);
  if (!authMethod) {
    openModal();
    return;
  }
  detach(connectNoAuth(authMethod), Reason.DomCallback);
}
