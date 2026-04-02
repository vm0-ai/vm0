import { useGet, useSet } from "ccstate-react";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  connectConnector$,
  pollingConnectorType$,
} from "../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { directedConnectType$ } from "../../signals/connectors-page/directed-connect-type.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconLoader2 } from "@tabler/icons-react";

export function ZeroDirectedConnectPage() {
  const type = useGet(directedConnectType$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const signal = useGet(pageSignal$);

  if (!type || !(type in CONNECTOR_TYPES)) {
    return null;
  }

  const connectorType = type as ConnectorType;
  const config = CONNECTOR_TYPES[connectorType];
  const isConnecting = pollingType === connectorType;

  const handleConnect = () => {
    detach(connect(connectorType, signal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-background p-10 shadow-sm max-w-md w-full text-center">
        <ConnectorIcon type={connectorType} size={40} />
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium text-muted-foreground">
            {config.label}
          </p>
          <h1 className="text-lg font-semibold text-foreground">
            Your current task needs {config.label} connector
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {config.helpText}
          </p>
        </div>
        <button
          type="button"
          disabled={isConnecting}
          onClick={handleConnect}
          className="inline-flex items-center gap-2 rounded-lg bg-[#e85d04] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#d35400] disabled:opacity-60 transition-colors"
        >
          {isConnecting && <IconLoader2 size={16} className="animate-spin" />}
          {isConnecting ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  );
}
