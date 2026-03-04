import { useLastResolved, useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { IconPlus } from "@tabler/icons-react";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import {
  addConnectionDialogTab$,
  setAddConnectionDialogTab$,
  allConnectorTypes$,
  pollingConnectorType$,
  connectConnector$,
  type ConnectorTypeWithStatus,
} from "../../signals/settings-page/connectors.ts";
import { openAddSecretDialog$ } from "../../signals/settings-page/secrets.ts";
import { openAddVariableDialog$ } from "../../signals/settings-page/variables.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// Connector row (for use inside dialog)
// ---------------------------------------------------------------------------

function ConnectorRowInDialog({ item }: { item: ConnectorTypeWithStatus }) {
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const isPolling = pollingType === item.type;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <ConnectorIcon type={item.type} size={28} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground truncate">
            {item.label}
          </div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground line-clamp-2">
        {item.helpText}
      </div>
      <div className="mt-auto">
        {item.connected ? (
          <span className="text-xs text-muted-foreground">Connected</span>
        ) : isPolling ? (
          <span className="text-xs text-muted-foreground">Connecting...</span>
        ) : (
          <button
            onClick={() =>
              detach(connect(item.type, pageSignal), Reason.DomCallback)
            }
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom API tab content
// ---------------------------------------------------------------------------

function CustomAPITabContent({
  onAddSecret,
  onAddVariable,
}: {
  onAddSecret: () => void;
  onAddVariable: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        Add custom API keys and environment variables for your agents.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onAddSecret}
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
              <IconPlus size={16} stroke={1.5} />
            </div>
            <span className="text-sm font-medium text-foreground">
              Add secret
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Store API keys and tokens for your agents.
          </p>
        </button>
        <button
          type="button"
          onClick={onAddVariable}
          className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
              <IconPlus size={16} stroke={1.5} />
            </div>
            <span className="text-sm font-medium text-foreground">
              Add variable
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Add environment variables for your agents.
          </p>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function AddConnectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tab = useGet(addConnectionDialogTab$);
  const setTab = useSet(setAddConnectionDialogTab$);
  const connectorTypes = useLastResolved(allConnectorTypes$);
  const types = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
  const openAddSecret = useSet(openAddSecretDialog$);
  const openAddVariable = useSet(openAddVariableDialog$);

  const handleAddSecret = () => {
    openAddSecret();
    onOpenChange(false);
  };

  const handleAddVariable = () => {
    openAddVariable();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden pr-0 pb-0">
        <DialogHeader>
          <DialogTitle>Add connection</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="pt-4 pb-6 pr-6">
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "connectors" | "custom-api")}
              className="flex flex-col min-h-0"
            >
              <TabsList className="w-fit">
                <TabsTrigger value="connectors">Connectors</TabsTrigger>
                <TabsTrigger value="custom-api">Custom API</TabsTrigger>
              </TabsList>
              {tab === "connectors" && (
                <div className="flex flex-col gap-4 mt-4">
                  <p className="text-sm text-muted-foreground">
                    Connect third-party services to your agents.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {connectorTypes
                      ? connectorTypes.map((item) => (
                          <ConnectorRowInDialog key={item.type} item={item} />
                        ))
                      : types.slice(0, 6).map((type) => (
                          <div
                            key={type}
                            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 animate-pulse"
                          >
                            <div className="flex items-center gap-3">
                              <div className="h-7 w-7 rounded bg-muted" />
                              <div className="h-4 w-20 rounded bg-muted" />
                            </div>
                            <div className="h-3 w-full rounded bg-muted" />
                            <div className="h-3 w-3/4 rounded bg-muted" />
                            <div className="h-7 w-full rounded bg-muted" />
                          </div>
                        ))}
                  </div>
                </div>
              )}
              {tab === "custom-api" && (
                <div className="mt-4">
                  <CustomAPITabContent
                    onAddSecret={handleAddSecret}
                    onAddVariable={handleAddVariable}
                  />
                </div>
              )}
            </Tabs>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
