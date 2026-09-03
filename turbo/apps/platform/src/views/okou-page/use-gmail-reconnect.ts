import { useGet, useLastResolved, useSet } from "ccstate-react";

import { connectorCatalogStatusBySlug$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectConnectorOAuthAuthCodeAndSettle$,
  connectFlowConnectorSlug$,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
} from "../../signals/okou-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function useGmailReconnect(
  connectionId: string | undefined,
  onSuccess: () => void | Promise<void>,
) {
  const catalogBySlug = useLastResolved(connectorCatalogStatusBySlug$);
  const connectFlowConnectorSlug = useGet(connectFlowConnectorSlug$);
  const connect = useSet(connectConnectorOAuthAuthCodeAndSettle$);
  const signal = useGet(pageSignal$);
  const connector = catalogBySlug?.get("gmail");
  const authMethod = connector
    ? getOnlyAvailableStatusBrowserAuthMethodDetail(connector)
    : null;
  const reconnecting = connectFlowConnectorSlug === "gmail";

  return {
    connectorIcon: connector?.icon,
    reconnecting,
    reconnectDisabled:
      !connectionId ||
      !connector ||
      !authMethod ||
      connectFlowConnectorSlug !== null,
    reconnect() {
      if (
        !connectionId ||
        !connector ||
        !authMethod ||
        connectFlowConnectorSlug !== null
      ) {
        return;
      }
      detach(
        connect(
          {
            connectorSlug: "gmail",
            method: authMethod,
            onSuccess,
            options: {
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
              connectorIcon: connector.icon,
              account: { intent: "reconnect", connectionId },
            },
          },
          signal,
        ),
        Reason.DomCallback,
      );
    },
  };
}
