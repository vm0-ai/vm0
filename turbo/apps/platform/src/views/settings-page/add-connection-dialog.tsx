import { useLastResolved, useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import {
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
} from "../../signals/settings-page/connectors.ts";
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
            detach(connect(item.type, pageSignal), Reason.DomCallback)
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

export function ConnectModal({ onClose }: { onClose: () => void }) {
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

        <ConnectModalContent item={item} onSuccess={onClose} />
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
}: {
  item: ConnectorTypeWithStatus;
  buttonClassName?: string;
}) {
  const setSelected = useSet(setSelectedConnectorType$);
  const connect = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingConnectorType$);
  const isPolling = pollingType === item.type;

  const hasOAuth = item.availableAuthMethods.includes("oauth");
  const hasApiToken = item.availableAuthMethods.includes("api-token");

  const handleConnect = () => {
    detach(connect(item.type, pageSignal), Reason.DomCallback);
  };

  const handleApiKey = () => {
    setSelected(item.type);
  };

  const btnClass = buttonClassName ?? DEFAULT_BUTTON_CLASS;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
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
          <span className="text-xs text-muted-foreground">
            {connectedStatusText(item)}
          </span>
        ) : isPolling ? (
          <span className="text-xs text-muted-foreground">Connecting...</span>
        ) : hasOAuth && hasApiToken ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConnect}
              className={`flex-1 ${btnClass}`}
            >
              Connect
            </button>
            <button
              type="button"
              onClick={handleApiKey}
              className={`flex-1 ${btnClass}`}
            >
              API key
            </button>
          </div>
        ) : hasApiToken ? (
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
            onClick={handleConnect}
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
// Add Connection Dialog
// ---------------------------------------------------------------------------

export function AddConnectionDialog({
  open,
  onOpenChange,
  variant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: "zero";
}) {
  const DUMMY_CONNECTOR_ITEMS: ConnectorTypeWithStatus[] = [
    {
      type: "notion",
      label: "Notion",
      helpText: "Connect your Notion workspace to access pages and databases",
      connected: true,
      connector: {
        id: null,
        type: "notion",
        authMethod: "oauth",
        externalId: null,
        externalUsername: "ming@vm0.ai",
        externalEmail: null,
        oauthScopes: null,
        createdAt: "",
        updatedAt: "",
      },
      availableAuthMethods: ["oauth"],
      scopeMismatch: false,
    },
    {
      type: "github",
      label: "GitHub",
      helpText:
        "Sign in with GitHub to manage repos, issues, and pull requests",
      connected: false,
      connector: null,
      availableAuthMethods: ["oauth"],
      scopeMismatch: false,
    },
    {
      type: "axiom",
      label: "Axiom",
      helpText:
        "Connect your Axiom account to query logs, manage datasets, and access observability data",
      connected: false,
      connector: null,
      availableAuthMethods: ["api-token"],
      scopeMismatch: false,
    },
    {
      type: "ahrefs",
      label: "Ahrefs",
      helpText:
        "Connect your Ahrefs account to access SEO data, backlink analysis, and keyword research",
      connected: false,
      connector: null,
      availableAuthMethods: ["oauth", "api-token"],
      scopeMismatch: false,
    },
  ];
  const connectorTypes = useLastResolved(allConnectorTypes$);
  const isZero = variant === "zero";
  const buttonClassName = isZero ? ZERO_BUTTON_CLASS : undefined;
  const contentClass = isZero
    ? "max-w-2xl max-h-[85vh] flex flex-col overflow-hidden pr-0 pb-0 zero-app"
    : "max-w-2xl max-h-[85vh] flex flex-col overflow-hidden pr-0 pb-0";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={contentClass}>
        <DialogHeader>
          <DialogTitle>Add skill</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="pt-4 pb-6 pr-6">
            <p className="text-sm text-muted-foreground mb-4">
              Skills manage your connections and help you get more out of these
              services.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {connectorTypes
                ? connectorTypes.map((item) => (
                    <ConnectorCard
                      key={item.type}
                      item={item}
                      buttonClassName={buttonClassName}
                    />
                  ))
                : DUMMY_CONNECTOR_ITEMS.map((item) => (
                    <ConnectorCard
                      key={item.type}
                      item={item}
                      buttonClassName={buttonClassName}
                    />
                  ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
