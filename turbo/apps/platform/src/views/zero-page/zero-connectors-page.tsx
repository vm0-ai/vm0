import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconSearch,
  IconPlug,
  IconPlus,
  IconLoader2,
  IconDotsVertical,
} from "@tabler/icons-react";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorTypes$,
  connectConnector$,
  connectorsSearch$,
  setConnectorsSearch$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  pollingConnectorType$,
  justConnectedTypes$,
  scopeReviewType$,
  setScopeReviewType$,
  permissionDialogType$,
  setPermissionDialogType$,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import { deleteConnector$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { ConnectorPermissionDialog } from "./components/settings/connector-permission-dialog.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason, throwIfAbort } from "../../signals/utils.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";

function GlobalConnectorCard({
  connector,
  isPolling,
  onConnect,
  onDisconnect,
  onReviewScopes,
}: {
  connector: ConnectorTypeWithStatus;
  isPolling: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onReviewScopes?: () => void;
}) {
  const status = (() => {
    if (isPolling) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
          Connecting…
        </span>
      );
    }
    if (connector.connected && connector.needsReconnect) {
      return (
        <span className="flex items-center gap-2 text-xs truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="text-amber-600 dark:text-amber-400">
            Connection expired
          </span>
          <button
            type="button"
            onClick={onConnect}
            className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
          >
            Reconnect
          </button>
        </span>
      );
    }
    if (connector.connected && connector.scopeMismatch) {
      return (
        <span className="flex items-center gap-2 text-xs truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="text-amber-600 dark:text-amber-400">
            Permissions update available
          </span>
          <button
            type="button"
            onClick={onReviewScopes}
            className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
          >
            Review
          </button>
        </span>
      );
    }
    if (connector.connected) {
      return (
        <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          {connector.connector?.externalUsername
            ? `@${connector.connector.externalUsername}`
            : "Connected"}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={onConnect}
        className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        Connect
      </button>
    );
  })();

  return (
    <div className="zero-card flex flex-col">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {connector.type in CONNECTOR_TYPES ? (
            <ConnectorIcon type={connector.type} size={20} />
          ) : (
            <IconPlug
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
          {connector.label}
        </span>
      </div>
      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex items-center gap-2 min-w-0">{status}</div>
        {connector.connected && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                aria-label="More options"
              >
                <IconDotsVertical size={14} stroke={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onDisconnect}>
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function AvailableConnectorCard({
  connector,
  isPolling,
  onConnect,
}: {
  connector: ConnectorTypeWithStatus;
  isPolling: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="zero-card cursor-pointer overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {connector.type in CONNECTOR_TYPES ? (
            <ConnectorIcon type={connector.type} size={20} />
          ) : (
            <IconPlug
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
          {connector.label}
        </span>
        {isPolling ? (
          <IconLoader2
            size={16}
            stroke={1.5}
            className="shrink-0 text-muted-foreground animate-spin"
          />
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={`Connect ${connector.label}`}
          >
            <IconPlus size={14} stroke={1.5} />
          </button>
        )}
      </div>
      <div className="px-5 pb-4 pt-1">
        <div
          data-testid="connector-help-text"
          className="text-xs text-muted-foreground line-clamp-2"
        >
          {connector.helpText ?? ""}
        </div>
      </div>
    </div>
  );
}

export function ZeroConnectorsPage() {
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const disconnect = useSet(deleteConnector$);
  const signal = useGet(pageSignal$);
  const selectedType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);
  const scopeReviewType = useGet(scopeReviewType$);
  const setScopeReviewType = useSet(setScopeReviewType$);
  const permissionDialogType = useGet(permissionDialogType$);
  const setPermissionDialogType = useSet(setPermissionDialogType$);
  const optimisticConnected = useGet(justConnectedTypes$);

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];

  const searchLower = search.toLowerCase();
  const filtered = allConnectors.filter((c) => {
    if (!searchLower) {
      return true;
    }
    return (
      c.label.toLowerCase().includes(searchLower) ||
      c.type.toLowerCase().includes(searchLower)
    );
  });

  const connected = filtered.filter((c) => {
    if (optimisticConnected.has(c.type)) {
      return true;
    }
    return c.connected;
  });
  const notConnected = filtered.filter((c) => {
    if (optimisticConnected.has(c.type)) {
      return false;
    }
    return !c.connected;
  });

  const connectHandler = (type: ConnectorType) => {
    const ct = allConnectors.find((c) => {
      return c.type === type;
    });
    if (
      ct &&
      ct.availableAuthMethods.length === 1 &&
      ct.availableAuthMethods[0] === "api-token"
    ) {
      setSelected(type);
    } else {
      detach(connect(type, signal), Reason.DomCallback);
    }
  };

  const disconnectHandler = (type: ConnectorType) => {
    const label =
      allConnectors.find((c) => {
        return c.type === type;
      })?.label ?? type;
    const toastId = toast.loading(`Disconnecting ${label}...`);
    detach(
      disconnect(type, signal).then(
        () => {
          return toast.success(`${label} disconnected`, { id: toastId });
        },
        (error: unknown) => {
          throwIfAbort(error);
          toast.error(`Failed to disconnect ${label}`, { id: toastId });
        },
      ),
      Reason.DomCallback,
    );
  };

  const getEffective = (c: ConnectorTypeWithStatus) => {
    return optimisticConnected.has(c.type) && !c.connected
      ? { ...c, connected: true }
      : c;
  };

  const renderCard = (c: ConnectorTypeWithStatus) => {
    return (
      <GlobalConnectorCard
        key={c.type}
        connector={getEffective(c)}
        isPolling={pollingType === c.type}
        onConnect={() => {
          return connectHandler(c.type);
        }}
        onDisconnect={() => {
          return disconnectHandler(c.type);
        }}
        onReviewScopes={() => {
          return setScopeReviewType(c.type);
        }}
      />
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-center justify-between gap-4">
            <div className="hidden md:block">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Connectors
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Connect third-party services for your agents to use.
              </p>
            </div>
            <div className="relative w-full md:w-56">
              <IconSearch
                size={15}
                stroke={1.5}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
              />
              <input
                type="text"
                placeholder="Search connectors"
                value={search}
                onChange={(e) => {
                  return setSearch(e.target.value);
                }}
                className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 pt-3 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {connected.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Connected ({connected.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {connected.map(renderCard)}
              </div>
            </section>
          )}

          {notConnected.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Available ({notConnected.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {notConnected.map((c) => {
                  return (
                    <AvailableConnectorCard
                      key={c.type}
                      connector={c}
                      isPolling={pollingType === c.type}
                      onConnect={() => {
                        return connectHandler(c.type);
                      }}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {allTypesLoadable.state !== "hasData" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 6 }, (_, i) => {
                return (
                  <div
                    key={i}
                    data-testid="connector-skeleton"
                    className="zero-card flex flex-col animate-pulse"
                  >
                    <div className="flex h-14 items-center gap-2.5 px-5">
                      <span className="h-5 w-5 shrink-0 rounded-lg bg-muted/50" />
                      <span className="h-4 w-24 rounded bg-muted/50" />
                    </div>
                    <div className="flex h-11 items-center border-t border-border/30 px-5">
                      <span className="h-3 w-16 rounded bg-muted/30" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {allTypesLoadable.state === "hasData" &&
            filtered.length === 0 &&
            search && (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No connectors matching &ldquo;{search}&rdquo;
              </p>
            )}
        </div>
      </main>

      {selectedType && (
        <ConnectModal
          onClose={() => {
            return setSelected(null);
          }}
          onSuccess={() => {
            const label =
              allConnectors.find((c) => {
                return c.type === selectedType;
              })?.label ?? selectedType;
            toast.success(`${label} connected`);
          }}
        />
      )}

      {scopeReviewType && (
        <ScopeReviewModal
          connectorType={scopeReviewType}
          onClose={() => {
            return setScopeReviewType(null);
          }}
          onReconnect={(type) => {
            setScopeReviewType(null);
            detach(connect(type, signal), Reason.DomCallback);
          }}
        />
      )}

      {permissionDialogType && (
        <ConnectorPermissionDialog
          connectorType={permissionDialogType}
          onClose={() => {
            setPermissionDialogType(null);
          }}
        />
      )}
    </div>
  );
}
