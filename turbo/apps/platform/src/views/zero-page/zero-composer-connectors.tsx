import { IconPlug, IconPlus } from "@tabler/icons-react";
import { detach, Reason } from "../../signals/utils.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";

export interface ComposerConnectorItem {
  type: string;
  label: string;
  iconUrl?: string;
  connected: boolean;
}

function ConnectorTriggerIcons({
  connectors,
}: {
  connectors: ComposerConnectorItem[];
}) {
  const connected = connectors.filter((c) => c.connected).slice(0, 3);
  if (connected.length === 0) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-1.5">
      {connected.map((c) => (
        <span
          key={c.type}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-background"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          {c.iconUrl ? (
            <img src={c.iconUrl} alt="" className="h-4 w-4" />
          ) : (
            <ConnectorIcon type={c.type as ConnectorType} size={16} />
          )}
        </span>
      ))}
    </span>
  );
}

export function ConnectorsPopoverButton({
  connectors,
  onOpenAddDialog,
  onConnect,
  onManageConnectors,
  agentName,
}: {
  connectors: ComposerConnectorItem[];
  onOpenAddDialog: () => void;
  onConnect: (type: string) => void;
  onManageConnectors?: () => void;
  agentName: string;
}) {
  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex shrink-0 items-center justify-center rounded-lg h-9 min-w-9 px-1.5 hover:bg-accent transition-colors"
              >
                <ConnectorTriggerIcons connectors={connectors} />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Connectors
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top" align="start" className="w-64 p-0 rounded-xl">
        {connectors.length > 0 && (
          <div className="p-2">
            <div className="flex flex-col">
              {connectors.map((item) => (
                <div
                  key={item.type}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center",
                      !item.connected && "opacity-40",
                    )}
                  >
                    {item.iconUrl ? (
                      <img src={item.iconUrl} alt="" className="h-5 w-5" />
                    ) : (
                      <ConnectorIcon
                        type={item.type as ConnectorType}
                        size={20}
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-sm flex-1",
                      item.connected
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {item.label}
                  </span>
                  {item.connected ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                  ) : (
                    <button
                      type="button"
                      className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        onConnect(item.type);
                      }}
                    >
                      Connect
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div
          className={cn(
            "p-2 flex flex-col",
            connectors.length > 0 && "border-t border-border/50",
          )}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => onOpenAddDialog()}
          >
            <IconPlus
              size={20}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Add connector
          </button>
          {onManageConnectors && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors"
              onClick={onManageConnectors}
            >
              <IconPlug
                size={20}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
              Manage connectors in {agentName}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function maybeClearOptimistic(
  optimistic: Set<string>,
  connectorMap: Map<ConnectorType, { connected: boolean }>,
  clear: () => void,
) {
  if (optimistic.size === 0) {
    return;
  }
  const allConfirmed = [...optimistic].every(
    (t) => connectorMap.get(t as ConnectorType)?.connected,
  );
  if (allConfirmed) {
    clear();
  }
}

export function buildConnectorItem(
  name: string,
  skillMap: Map<string, { label: string; icon?: string }>,
  connectorMap: Map<ConnectorType, { label: string; connected: boolean }>,
  optimistic: Set<string>,
): ComposerConnectorItem {
  const skill = skillMap.get(name);
  const connector = connectorMap.get(name as ConnectorType);
  return {
    type: name,
    label: skill?.label ?? connector?.label ?? name,
    iconUrl: skill?.icon,
    connected: optimistic.has(name) ? true : (connector?.connected ?? false),
  };
}

export function resolveConnectorLabel(
  type: string,
  skillMap: Map<string, { label: string }>,
  connectorMap: Map<ConnectorType, { label: string }>,
): string {
  return (
    skillMap.get(type)?.label ??
    connectorMap.get(type as ConnectorType)?.label ??
    type
  );
}

export function startConnectorFlow(
  type: string,
  connectorMap: Map<ConnectorType, { availableAuthMethods: string[] }>,
  setSelectedType: (t: ConnectorType | null) => void,
  connect: (t: ConnectorType, signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
) {
  const ct = connectorMap.get(type as ConnectorType);
  if (!ct) {
    return;
  }
  if (
    ct.availableAuthMethods.length === 1 &&
    ct.availableAuthMethods[0] === "api-token"
  ) {
    setSelectedType(type as ConnectorType);
  } else {
    detach(connect(type as ConnectorType, signal), Reason.DomCallback);
  }
}
