import { useLastResolved, useGet, useSet } from "ccstate-react";
import {
  IconDotsVertical,
  IconCircleCheck,
  IconLoader,
} from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import {
  allConnectorTypes$,
  pollingConnectorType$,
  connectConnector$,
  openDisconnectDialog$,
  type ConnectorTypeWithStatus,
} from "../../signals/settings-page/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, Reason } from "../../signals/utils.ts";

function ConnectorRow({
  item,
  isFirst,
  isLast,
}: {
  item: ConnectorTypeWithStatus;
  isFirst: boolean;
  isLast: boolean;
}) {
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const openDisconnect = useSet(openDisconnectDialog$);
  const pageSignal = useGet(pageSignal$);

  const isPolling = pollingType === item.type;

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 ${isFirst ? "rounded-t-xl" : ""} ${isLast ? "rounded-b-xl border-b" : ""}`}
    >
      <div className="shrink-0">
        <ConnectorIcon type={item.type} size={28} />
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{item.label}</div>
        <div className="text-sm text-muted-foreground">{item.helpText}</div>
      </div>

      {/* Status */}
      <div className="shrink-0">
        {item.connected && item.connector?.externalUsername && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
            <IconCircleCheck className="h-3 w-3 text-green-600" />
            Connected as {item.connector.externalUsername}
          </span>
        )}
        {item.connected && !item.connector?.externalUsername && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
            <IconCircleCheck className="h-3 w-3 text-green-600" />
            Connected
          </span>
        )}
        {!item.connected && isPolling && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
            <IconLoader className="h-3 w-3 text-yellow-600 animate-spin" />
            Connecting...
          </span>
        )}
      </div>

      {/* Action */}
      {item.connected ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="icon-button shrink-0"
              aria-label="Connector options"
            >
              <IconDotsVertical
                size={16}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex flex-col gap-1 w-36 p-2">
            <button
              onClick={() => openDisconnect(item.type)}
              className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Disconnect
            </button>
          </PopoverContent>
        </Popover>
      ) : (
        !isPolling && (
          <button
            onClick={() =>
              detach(connect(item.type, pageSignal), Reason.DomCallback)
            }
            className="flex items-center shrink-0 rounded-lg border border-border bg-background overflow-hidden hover:bg-muted transition-colors"
          >
            <span className="px-4 py-2 text-sm font-medium text-foreground">
              Connect
            </span>
          </button>
        )
      )}
    </div>
  );
}

export function ConnectorList() {
  const connectorTypes = useLastResolved(allConnectorTypes$);
  const types = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">Connectors</h3>
        <p className="text-sm text-muted-foreground">
          Connect third-party services to your agents.
        </p>
      </div>

      <div className="flex flex-col">
        {connectorTypes
          ? connectorTypes.map((item, index) => (
              <ConnectorRow
                key={item.type}
                item={item}
                isFirst={index === 0}
                isLast={index === connectorTypes.length - 1}
              />
            ))
          : types.map((type, index) => (
              <div
                key={type}
                className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 animate-pulse ${index === 0 ? "rounded-t-xl" : ""} ${index === types.length - 1 ? "rounded-b-xl border-b" : ""}`}
              >
                <div className="h-7 w-7 rounded bg-muted" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                  <div className="h-3 w-48 rounded bg-muted" />
                </div>
              </div>
            ))}
      </div>
    </div>
  );
}
