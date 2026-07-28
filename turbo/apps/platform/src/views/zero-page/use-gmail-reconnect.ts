import { useGet, useLastResolved, useSet } from "ccstate-react";

import { connectorCatalogStatusByRef$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectConnectorOAuthAuthCodeAndSettle$,
  connectFlowConnectorRef$,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
} from "../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function useGmailReconnect(onSuccess: () => void | Promise<void>) {
  const catalogByRef = useLastResolved(connectorCatalogStatusByRef$);
  const connectFlowConnectorRef = useGet(connectFlowConnectorRef$);
  const connect = useSet(connectConnectorOAuthAuthCodeAndSettle$);
  const signal = useGet(pageSignal$);
  const connector = catalogByRef?.get("gmail");
  const authMethod = connector
    ? getOnlyAvailableStatusBrowserAuthMethodDetail(connector)
    : null;
  const reconnecting = connectFlowConnectorRef === "gmail";

  return {
    connectorIcon: connector?.icon,
    reconnecting,
    reconnectDisabled:
      !connector || !authMethod || connectFlowConnectorRef !== null,
    reconnect() {
      if (!connector || !authMethod || connectFlowConnectorRef !== null) {
        return;
      }
      detach(
        connect(
          {
            connectorRef: "gmail",
            method: authMethod,
            onSuccess,
            options: {
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
              connectorIcon: connector.icon,
            },
          },
          signal,
        ),
        Reason.DomCallback,
      );
    },
  };
}
