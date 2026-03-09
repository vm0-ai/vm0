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
  submitApiToken$,
  tokenFormSubmitting$,
  setTokenFormValue$,
  clearTokenForm$,
  tokenFormValuesFor$,
  setTokenFormSubmitting$,
  activeAuthMethods$,
  setActiveAuthMethod$,
  type ConnectorTypeWithStatus,
} from "../../signals/settings-page/connectors.ts";
import { openAddSecretDialog$ } from "../../signals/settings-page/secrets.ts";
import { openAddVariableDialog$ } from "../../signals/settings-page/variables.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, Reason } from "../../signals/utils.ts";

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
// API Token form (inline within connector card)
// ---------------------------------------------------------------------------

function ApiTokenForm({
  type,
  item,
}: {
  type: ConnectorType;
  item: ConnectorTypeWithStatus;
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
      })().catch(() => {
        setSubmitting(null);
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {item.connected && item.connector?.authMethod === "oauth" && (
        <p className="text-xs text-amber-600">
          This will replace your current OAuth connection.
        </p>
      )}
      {apiTokenConfig.helpText && (
        <div
          className="text-xs text-muted-foreground leading-relaxed [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(apiTokenConfig.helpText),
          }}
        />
      )}
      {secretEntries.map(([name, secretConfig]) => (
        <div key={name} className="flex flex-col gap-1">
          <label className="text-xs font-medium text-foreground">
            {secretConfig.label}
          </label>
          <input
            type="password"
            placeholder={secretConfig.placeholder}
            value={secretValues[name] ?? ""}
            onChange={(e) => setFormValue(type, name, e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      ))}
      <button
        onClick={handleSubmit}
        disabled={!allFilled || submitting}
        className="rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth method selector (extracted to reduce complexity)
// ---------------------------------------------------------------------------

function ConnectorAuthActions({ item }: { item: ConnectorTypeWithStatus }) {
  const connect = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const activeAuthMethodMap = useGet(activeAuthMethods$);
  const setActiveAuthMethod = useSet(setActiveAuthMethod$);

  const hasOAuth = item.availableAuthMethods.includes("oauth");
  const hasApiToken = item.availableAuthMethods.includes("api-token");
  const hasMultipleMethods = hasOAuth && hasApiToken;

  const defaultTab =
    item.connector?.authMethod === "api-token" && hasApiToken
      ? "api-token"
      : hasOAuth
        ? "oauth"
        : "api-token";

  const activeMethod = activeAuthMethodMap[item.type] ?? defaultTab;

  return (
    <div className="mt-auto flex flex-col gap-2">
      {hasMultipleMethods && (
        <div className="flex gap-1 rounded-md bg-muted p-0.5">
          <button
            onClick={() => setActiveAuthMethod(item.type, "oauth")}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              activeMethod === "oauth"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            OAuth
          </button>
          <button
            onClick={() => setActiveAuthMethod(item.type, "api-token")}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              activeMethod === "api-token"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {CONNECTOR_TYPES[item.type].authMethods["api-token"]?.label ??
              "API Token"}
          </button>
        </div>
      )}

      {activeMethod === "oauth" && hasOAuth && (
        <button
          onClick={() =>
            detach(connect(item.type, pageSignal), Reason.DomCallback)
          }
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        >
          Connect
        </button>
      )}

      {activeMethod === "api-token" && hasApiToken && (
        <ApiTokenForm type={item.type} item={item} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected status text helper
// ---------------------------------------------------------------------------

function connectedStatusText(item: ConnectorTypeWithStatus): string {
  if (item.connector?.authMethod === "api-token") {
    return "Connected via API Token";
  }
  if (item.connector?.externalUsername) {
    return `Connected as @${item.connector.externalUsername}`;
  }
  return "Connected";
}

// ---------------------------------------------------------------------------
// Connector row (for use inside dialog)
// ---------------------------------------------------------------------------

function ConnectorRowInDialog({ item }: { item: ConnectorTypeWithStatus }) {
  const pollingType = useGet(pollingConnectorType$);
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

      {item.connected ? (
        <div className="mt-auto">
          <span className="text-xs text-muted-foreground">
            {connectedStatusText(item)}
          </span>
        </div>
      ) : isPolling ? (
        <div className="mt-auto">
          <span className="text-xs text-muted-foreground">Connecting...</span>
        </div>
      ) : (
        <ConnectorAuthActions item={item} />
      )}
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
