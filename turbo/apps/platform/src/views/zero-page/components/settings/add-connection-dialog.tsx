import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import { IconSearch, IconPlus } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import {
  addConnectionDialogTab$,
  setAddConnectionDialogTab$,
  allConnectorTypes$,
  pollingConnectorType$,
  connectConnector$,
  submitApiToken$,
  tokenFormSubmitting$,
  setTokenFormValue$,
  clearTokenForm$,
  tokenFormValuesFor$,
  setTokenFormSubmitting$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { openAddSecretDialog$ } from "../../../../signals/zero-page/settings/secrets.ts";
import { openAddVariableDialog$ } from "../../../../signals/zero-page/settings/variables.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";

// ---------------------------------------------------------------------------
// Inline markdown renderer for help text
// ---------------------------------------------------------------------------

function renderMarkdown(text: string): string {
  return text
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary underline">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /^> (.+)$/gm,
      '<div class="pl-3 border-l-2 border-muted text-muted-foreground">$1</div>',
    );
}

// ---------------------------------------------------------------------------
// Connected status text helper
// ---------------------------------------------------------------------------

function connectedStatusText(item: ConnectorTypeWithStatus): string {
  if (item.needsReconnect) {
    return "Connection expired";
  }
  if (item.connector?.authMethod === "api-token") {
    return "Connected via API Token";
  }
  if (item.connector?.externalUsername) {
    return `Connected as @${item.connector.externalUsername}`;
  }
  return "Connected";
}

// ---------------------------------------------------------------------------
// API Token form (shown inside connect modal)
// ---------------------------------------------------------------------------

function ApiTokenForm({
  type,
  item,
  onSuccess,
}: {
  type: ConnectorType;
  item: ConnectorTypeWithStatus;
  onSuccess: () => void;
}) {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"];
  const submit = useSet(submitApiToken$);
  const setFormValue = useSet(setTokenFormValue$);
  const clearForm = useSet(clearTokenForm$);
  const pageSignal = useGet(pageSignal$);
  const secretValues = useGet(tokenFormValuesFor$(type));
  const submittingType = useGet(tokenFormSubmitting$);
  const setSubmitting = useSet(setTokenFormSubmitting$);
  const submitting = submittingType === type;

  if (!apiTokenConfig) {
    return null;
  }

  const secretEntries = Object.entries(apiTokenConfig.secrets);
  const allFilled = secretEntries.every(
    ([name, cfg]) => !cfg.required || secretValues[name],
  );

  const handleSubmit = () => {
    if (!allFilled || submitting) {
      return;
    }
    setSubmitting(type);
    detach(
      (async () => {
        await submit(type, secretValues, pageSignal);
        setSubmitting(null);
        clearForm(type);
        onSuccess();
      })().catch(() => {
        setSubmitting(null);
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {item.connected && item.connector?.authMethod === "oauth" && (
        <p className="text-xs text-amber-600">
          This will replace your current OAuth connection.
        </p>
      )}
      {apiTokenConfig.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(apiTokenConfig.helpText),
          }}
        />
      )}
      {secretEntries.map(([name, secretConfig]) => (
        <div key={name} className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground">
            {secretConfig.label}
          </label>
          <input
            type="password"
            placeholder={secretConfig.placeholder}
            value={secretValues[name] ?? ""}
            onChange={(e) => setFormValue(type, name, e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      ))}
      <button
        onClick={handleSubmit}
        disabled={!allFilled || submitting}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect modal content (OAuth button + token form, or just token form)
// ---------------------------------------------------------------------------

function ConnectModalContent({
  item,
  onSuccess,
}: {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void;
}) {
  const connect = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingConnectorType$);
  const isPolling = pollingType === item.type;

  const config = CONNECTOR_TYPES[item.type];
  const hasOAuth = item.availableAuthMethods.includes("oauth");
  const hasApiToken = item.availableAuthMethods.includes("api-token");

  // While OAuth is in progress, only show connecting state
  if (isPolling) {
    return <p className="text-sm text-muted-foreground">Connecting...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {hasOAuth && (
        <button
          onClick={() =>
            detach(
              (async () => {
                const connected = await connect(item.type, pageSignal);
                if (connected) {
                  onSuccess();
                }
              })(),
              Reason.DomCallback,
            )
          }
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          Sign in with {config.label}
        </button>
      )}

      {hasOAuth && hasApiToken && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>
      )}

      {hasApiToken && (
        <ApiTokenForm type={item.type} item={item} onSuccess={onSuccess} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect modal (opened when clicking Connect on a connector with api-token)
// ---------------------------------------------------------------------------

export function ConnectModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const selectedType = useGet(selectedConnectorType$);
  const connectorTypes = useLastResolved(allConnectorTypes$);

  const item = connectorTypes?.find((c) => c.type === selectedType);

  if (!selectedType || !item) {
    return null;
  }

  const config = CONNECTOR_TYPES[selectedType];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={selectedType} size={28} />
            <DialogTitle>{config.label}</DialogTitle>
          </div>
        </DialogHeader>

        {item.connected && (
          <p className="text-sm text-muted-foreground">
            {connectedStatusText(item)}
          </p>
        )}

        <ConnectModalContent
          item={item}
          onSuccess={() => {
            onSuccess?.();
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Connector card (shows Connect button when not connected)
// ---------------------------------------------------------------------------

const DEFAULT_BUTTON_CLASS =
  "rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors";

const ZERO_BUTTON_CLASS =
  "zero-btn-morandi h-8 rounded-lg border px-3 text-sm font-medium transition-colors";

function ConnectorCard({
  item,
  buttonClassName,
  onConnectSuccess,
  onAdd,
}: {
  item: ConnectorTypeWithStatus;
  buttonClassName?: string;
  onConnectSuccess?: (type: ConnectorType) => void;
  onAdd?: (type: ConnectorType) => void;
}) {
  const setSelected = useSet(setSelectedConnectorType$);
  const connect = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingConnectorType$);
  const isPolling = pollingType === item.type;

  const hasApiToken = item.availableAuthMethods.includes("api-token");

  const handleConnect = () => {
    detach(
      (async () => {
        const connected = await connect(item.type, pageSignal);
        if (connected) {
          onConnectSuccess?.(item.type);
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleApiKey = () => {
    setSelected(item.type);
  };

  const btnClass = buttonClassName ?? DEFAULT_BUTTON_CLASS;

  // Card click: already connected → add; needs API key → open modal; OAuth only → start OAuth
  const handleCardClick = () => {
    if (item.connected) {
      onAdd?.(item.type);
    } else if (hasApiToken) {
      handleApiKey();
    } else {
      handleConnect();
    }
  };

  const clickable = !!onAdd || !item.connected;

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-border bg-card p-4${clickable ? " cursor-pointer transition-colors hover:bg-muted/50" : ""}`}
      onClick={clickable ? handleCardClick : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleCardClick();
              }
            }
          : undefined
      }
    >
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
      <div className="mt-auto" onClick={(e) => e.stopPropagation()}>
        {item.connected ? (
          <span
            className={`text-xs ${item.needsReconnect ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
          >
            {connectedStatusText(item)}
          </span>
        ) : isPolling ? (
          <span className="text-xs text-muted-foreground">Connecting...</span>
        ) : hasApiToken && onAdd ? (
          <button
            type="button"
            onClick={handleApiKey}
            className={`w-full ${btnClass}`}
          >
            API key
          </button>
        ) : (
          <button
            type="button"
            onClick={hasApiToken ? handleApiKey : handleConnect}
            className={`w-full ${btnClass}`}
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom API tab content (settings page only)
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
// Connector grid (shared between default and zero variants)
// ---------------------------------------------------------------------------

function ConnectorGrid({
  types,
  connectorTypes,
  buttonClassName,
  onConnectSuccess,
  onAdd,
}: {
  types: ConnectorType[];
  connectorTypes: ConnectorTypeWithStatus[] | undefined;
  buttonClassName?: string;
  onConnectSuccess?: (type: ConnectorType) => void;
  onAdd?: (type: ConnectorType) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {connectorTypes
        ? connectorTypes.map((item) => (
            <ConnectorCard
              key={item.type}
              item={item}
              buttonClassName={buttonClassName}
              onConnectSuccess={onConnectSuccess}
              onAdd={onAdd}
            />
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
  );
}

// ---------------------------------------------------------------------------
// Add Connection Dialog
// ---------------------------------------------------------------------------

export function AddConnectionDialog({
  open,
  onOpenChange,
  variant,
  excludeTypes,
  onConnectSuccess,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: "zero";
  excludeTypes?: ReadonlySet<string>;
  onConnectSuccess?: (type: ConnectorType) => void;
  onAdd?: (type: ConnectorType) => void;
}) {
  const isZero = variant === "zero";

  if (isZero) {
    return (
      <ZeroAddConnectionDialog
        open={open}
        onOpenChange={onOpenChange}
        excludeTypes={excludeTypes}
        onConnectSuccess={onConnectSuccess}
        onAdd={onAdd}
      />
    );
  }

  return <DefaultAddConnectionDialog open={open} onOpenChange={onOpenChange} />;
}

// ---------------------------------------------------------------------------
// Default (settings) variant: tabbed dialog with Connectors + Custom API
// ---------------------------------------------------------------------------

function DefaultAddConnectionDialog({
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
                  <ConnectorGrid
                    types={types}
                    connectorTypes={connectorTypes ?? undefined}
                  />
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

// ---------------------------------------------------------------------------
// Zero variant: flat search-based dialog
// ---------------------------------------------------------------------------

function ZeroAddConnectionDialog({
  open,
  onOpenChange,
  excludeTypes,
  onConnectSuccess,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeTypes?: ReadonlySet<string>;
  onConnectSuccess?: (type: ConnectorType) => void;
  onAdd?: (type: ConnectorType) => void;
}) {
  const connectorTypes = useLastResolved(allConnectorTypes$);
  const search$ = useCCState("");
  const search = useGet(search$);
  const setSearch = useSet(search$);
  const types = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

  const filteredTypes = connectorTypes
    ?.filter((item) => !excludeTypes || !excludeTypes.has(item.type))
    .filter((item) => {
      if (!search.trim()) {
        return true;
      }
      const q = search.trim().toLowerCase();
      return (
        item.type.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.helpText?.toLowerCase().includes(q)
      );
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setSearch("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl h-[85vh] flex flex-col overflow-hidden pr-0 pb-0 zero-app">
        <DialogHeader>
          <DialogTitle>Add connector</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground pr-6">
          Connectors let your agents access and interact with third-party
          services.
        </p>
        <div className="relative pr-6">
          <IconSearch
            size={16}
            stroke={1.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search connectors..."
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="pt-4 pb-6 pr-6">
            {filteredTypes && filteredTypes.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No matching connectors found.
              </p>
            ) : (
              <ConnectorGrid
                types={types}
                connectorTypes={filteredTypes ?? undefined}
                buttonClassName={ZERO_BUTTON_CLASS}
                onConnectSuccess={onConnectSuccess}
                onAdd={onAdd}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
