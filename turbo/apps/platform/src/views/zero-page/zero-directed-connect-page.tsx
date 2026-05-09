import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { isGoogleOAuthConnector } from "@vm0/connectors/connector-utils";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorTypes$,
  connectConnector$,
  justConnectedTypes$,
  pollingConnectorType$,
  submitApiToken$,
  tokenFormSubmitting$,
  setTokenFormValue$,
  clearTokenForm$,
  tokenFormValuesFor$,
  setTokenFormSubmitting$,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
import {
  directedConnectType$,
  directedConnectAgentId$,
  directedConnectAgentName$,
  tokenDialogOpen$,
  setTokenDialogOpen$,
} from "../../signals/connectors-page/directed-connect-type.ts";
import { authorizeConnector$ } from "../../signals/connectors-page/directed-authorize-type.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Vm0LogoLink, GoogleOAuthNotice } from "./zero-directed-shared.tsx";

function runDirectedConnect(params: {
  authMethods: string[];
  connectorType: ConnectorType;
  signal: AbortSignal;
  connect: (
    type: ConnectorType,
    options: { readonly showPermissionDialog?: boolean },
    signal: AbortSignal,
  ) => Promise<boolean>;
  onConnected: () => Promise<void>;
  openTokenDialog: () => void;
}): void {
  const hasOAuth = params.authMethods.includes("oauth");
  const hasApiToken = params.authMethods.includes("api-token");

  // Priority: OAuth launches the external popup; api-token opens the modal so
  // the user can enter credentials.
  if (!hasOAuth && hasApiToken) {
    params.openTokenDialog();
    return;
  }
  // Defensive fallback for the degenerate empty-authMethods case — the
  // contract disallows it today, so in practice this is unreachable after
  // the api-token branch above.
  if (!hasOAuth) {
    params.openTokenDialog();
    return;
  }
  detach(
    (async () => {
      let connected = true;
      connected = await params.connect(params.connectorType, {}, params.signal);
      if (connected) {
        await params.onConnected();
      }
    })(),
    Reason.DomCallback,
  );
}

// Only intended for trusted, source-controlled help text from
// `CONNECTOR_TYPES[*].authMethods.*.helpText`. Do NOT feed user-supplied
// strings into this renderer — the `[text]` and `**bold**` captures are
// verbatim-injected and would permit HTML smuggling.
function renderMarkdown(text: string): string {
  return text
    .replace(
      // Only http(s) URLs are turned into anchors; other schemes fall through
      // as literal text. `"` is also excluded from the href charclass so a
      // stray quote cannot break out of the href attribute and inject
      // siblings like `onclick` when feeding `dangerouslySetInnerHTML`.
      /\[([^\]]+)\]\((https?:\/\/[^)"]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary underline">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function ApiTokenForm({
  type,
  onSuccess,
}: {
  type: ConnectorType;
  onSuccess: () => void;
}) {
  const apiTokenConfig = CONNECTOR_TYPES[type].authMethods["api-token"];
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
  const allFilled = secretEntries.every(([name, cfg]) => {
    return !cfg.required || secretValues[name];
  });

  const handleSubmit = onDomEventFn(async () => {
    if (!allFilled || submitting) {
      return;
    }
    setSubmitting(type);
    await bestEffort(
      (async () => {
        await submit(type, secretValues, {}, pageSignal);
        clearForm(type);
        onSuccess();
      })(),
    );
    setSubmitting(null);
  });

  return (
    <div className="flex w-full flex-col gap-3 text-left">
      {apiTokenConfig.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(apiTokenConfig.helpText),
          }}
        />
      )}
      {secretEntries.map(([name, secretConfig]) => {
        return (
          <div key={name} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {secretConfig.label}
            </label>
            <Input
              type="password"
              placeholder={secretConfig.placeholder}
              value={secretValues[name] ?? ""}
              onChange={(e) => {
                return setFormValue(type, name, e.target.value);
              }}
            />
          </div>
        );
      })}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!allFilled || submitting}
        className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
      >
        {submitting && <IconLoader2 size={14} className="animate-spin" />}
        {submitting ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

function ApiTokenDialog({
  type,
  open,
  onOpenChange,
  onConnected,
}: {
  type: ConnectorType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}) {
  const config = CONNECTOR_TYPES[type];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={type} size={20} />
            <DialogTitle>{config.label}</DialogTitle>
          </div>
        </DialogHeader>
        <ApiTokenForm
          type={type}
          onSuccess={() => {
            onOpenChange(false);
            onConnected?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectActions({
  isConnected,
  isConnecting,
  onConnect,
}: {
  isConnected: boolean;
  isConnecting: boolean;
  onConnect: () => void;
}) {
  if (isConnected) {
    return (
      <>
        <div className="inline-flex h-9 w-[100px] items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
          <IconCheck size={16} />
          Connected
        </div>
        <button
          type="button"
          disabled={isConnecting}
          onClick={onConnect}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60 inline-flex items-center gap-1.5"
        >
          {isConnecting && <IconLoader2 size={12} className="animate-spin" />}
          {isConnecting ? "Reconnecting..." : "Reconnect"}
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      disabled={isConnecting}
      onClick={onConnect}
      className="inline-flex h-9 w-[100px] items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
    >
      {isConnecting && <IconLoader2 size={14} className="animate-spin" />}
      {isConnecting ? "Connecting..." : "Connect"}
    </button>
  );
}

function DirectedConnectCard() {
  const type = useGet(directedConnectType$);
  const agentId = useGet(directedConnectAgentId$);
  const agentNameLoadable = useLastLoadable(directedConnectAgentName$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const authorize = useSet(authorizeConnector$);
  const signal = useGet(pageSignal$);
  const justConnected = useGet(justConnectedTypes$);
  const allLoadable = useLastLoadable(allConnectorTypes$);
  const tokenDialogOpen = useGet(tokenDialogOpen$);
  const setTokenDialogOpen = useSet(setTokenDialogOpen$);

  if (!type || !(type in CONNECTOR_TYPES)) {
    return null;
  }

  const connectorType = type as ConnectorType;
  const config = CONNECTOR_TYPES[connectorType];
  const agentName =
    agentNameLoadable.state === "hasData" && agentNameLoadable.data
      ? agentNameLoadable.data
      : "Zero";
  const isConnecting = pollingType === connectorType;
  const isLoading =
    !justConnected.has(connectorType) && allLoadable.state === "loading";
  const allData = allLoadable.state === "hasData" ? allLoadable.data : [];
  const item = allData.find((c) => {
    return c.type === connectorType;
  });
  const isConnected =
    justConnected.has(connectorType) || (item?.connected ?? false);

  const runPostConnectActions = async () => {
    if (agentId) {
      await authorize(connectorType, agentId, signal);
    }
  };

  const handleConnect = () => {
    runDirectedConnect({
      authMethods:
        item?.availableAuthMethods ?? Object.keys(config.authMethods),
      connectorType,
      signal,
      connect,
      onConnected: runPostConnectActions,
      openTokenDialog: () => {
        return setTokenDialogOpen(true);
      },
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
          <Vm0LogoLink />
          <div className="flex w-full flex-col gap-4">
            <div className="flex flex-col items-center gap-2.5">
              {isLoading ? (
                <IconLoader2
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
              ) : (
                <>
                  <h1 className="text-lg font-medium text-foreground">
                    {isConnected
                      ? `${config.label} connected`
                      : `${agentName} needs ${config.label} to proceed`}
                  </h1>
                  <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
                    <ConnectorIcon type={connectorType} size={20} />
                  </div>
                  <p className="w-60 text-sm text-muted-foreground">
                    {config.helpText}
                  </p>
                  {!isConnected && isGoogleOAuthConnector(connectorType) && (
                    <GoogleOAuthNotice />
                  )}
                </>
              )}
            </div>
            {!isLoading && (
              <div className="flex flex-col items-center justify-center gap-2">
                <ConnectActions
                  isConnected={isConnected}
                  isConnecting={isConnecting}
                  onConnect={handleConnect}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <ApiTokenDialog
        type={connectorType}
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
        onConnected={
          agentId
            ? () => {
                detach(runPostConnectActions(), Reason.DomCallback);
              }
            : undefined
        }
      />
    </>
  );
}

export function ZeroDirectedConnectPage() {
  return <DirectedConnectCard />;
}
