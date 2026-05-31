import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorManualGrantConfig,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethod,
  isGoogleOAuthConnector,
} from "@vm0/connectors/connector-utils";
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
  connectConnectorOAuthAuthCode$,
  getConnectorConnectLaunchMode,
  justConnectedTypes$,
  pollingOAuthAuthCodeConnectorType$,
  pollingOAuthDeviceAuthConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  submitManualGrant$,
  manualGrantFormSubmitting$,
  setManualGrantFormValue$,
  clearManualGrantForm$,
  manualGrantFormValuesFor$,
  setManualGrantFormSubmitting$,
} from "../../signals/zero-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../signals/zero-page/settings/token-input.ts";
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
  manualGrantDialogOpen$,
  setManualGrantDialogOpen$,
} from "../../signals/connectors-page/directed-connect-type.ts";
import { authorizeConnector$ } from "../../signals/connectors-page/directed-authorize-type.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Vm0LogoLink, GoogleOAuthNotice } from "./zero-directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";

type ManualGrantMethod = {
  readonly authMethod: ConnectorAuthMethodId;
  readonly method: ConnectorAuthMethodConfig;
  readonly grant: ConnectorManualGrantConfig;
};

function getManualGrantMethod(
  connectorType: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): ManualGrantMethod | null {
  for (const authMethod of authMethods) {
    const method = getConnectorAuthMethod(connectorType, authMethod);
    switch (method?.grant.kind) {
      case "manual": {
        return {
          authMethod,
          method,
          grant: method.grant,
        };
      }
      case "auth-code":
      case "device-auth":
      case "managed":
      case undefined: {
        continue;
      }
    }
  }
  return null;
}

function hasProviderDrivenConnectMethod(
  connectorType: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): boolean {
  return authMethods.some((authMethod) => {
    const method = getConnectorAuthMethod(connectorType, authMethod);
    switch (method?.grant.kind) {
      case "auth-code":
      case "device-auth":
      case "managed": {
        return true;
      }
      case "manual":
      case undefined: {
        return false;
      }
    }
    return false;
  });
}

function runDirectedConnect(params: {
  authMethods: readonly ConnectorAuthMethodId[];
  connectorType: ConnectorType;
  signal: AbortSignal;
  connect: (
    type: ConnectorType,
    options: { readonly showPermissionDialog?: boolean },
    signal: AbortSignal,
  ) => Promise<boolean>;
  onConnected: () => Promise<void>;
  openConnectModal: () => void;
  openManualGrantDialog: () => void;
}): void {
  const launchMode = getConnectorConnectLaunchMode({
    type: params.connectorType,
    availableAuthMethods: params.authMethods,
  });
  if (
    launchMode === "modal" &&
    hasProviderDrivenConnectMethod(params.connectorType, params.authMethods)
  ) {
    params.openConnectModal();
    return;
  }

  const manualGrantMethod = getManualGrantMethod(
    params.connectorType,
    params.authMethods,
  );

  if (launchMode === "modal" && manualGrantMethod) {
    params.openManualGrantDialog();
    return;
  }
  if (launchMode === "modal") {
    params.openConnectModal();
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

function ManualGrantForm({
  type,
  manualGrantMethod,
  onSuccess,
}: {
  type: ConnectorType;
  manualGrantMethod: ManualGrantMethod;
  onSuccess: () => void;
}) {
  const submit = useSet(submitManualGrant$);
  const setFormValue = useSet(setManualGrantFormValue$);
  const clearForm = useSet(clearManualGrantForm$);
  const pageSignal = useGet(pageSignal$);
  const fieldValues = useGet(manualGrantFormValuesFor$(type));
  const submittingType = useGet(manualGrantFormSubmitting$);
  const setSubmitting = useSet(setManualGrantFormSubmitting$);
  const submitting = submittingType === type;

  const fieldEntries = Object.entries(manualGrantMethod.grant.fields);
  const allFilled = fieldEntries.every(([name, cfg]) => {
    return !cfg.required || hasTokenInputValue(fieldValues[name]);
  });

  const handleSubmit = onDomEventFn(async () => {
    if (!allFilled || submitting) {
      return;
    }
    setSubmitting(type);
    await bestEffort(
      (async () => {
        await submit(
          {
            type,
            authMethod: manualGrantMethod.authMethod,
            inputValues: fieldValues,
            options: {},
          },
          pageSignal,
        );
        clearForm(type);
        onSuccess();
      })(),
    );
    setSubmitting(null);
  });

  return (
    <div className="flex w-full flex-col gap-3 text-left">
      {manualGrantMethod.method.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(manualGrantMethod.method.helpText),
          }}
        />
      )}
      {fieldEntries.map(([name, fieldConfig]) => {
        return (
          <div key={name} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {fieldConfig.label}
            </label>
            <Input
              type="password"
              placeholder={fieldConfig.placeholder}
              value={fieldValues[name] ?? ""}
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

function ManualGrantDialog({
  type,
  manualGrantMethod,
  open,
  onOpenChange,
  onConnected,
}: {
  type: ConnectorType;
  manualGrantMethod: ManualGrantMethod | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}) {
  const config = CONNECTOR_TYPES[type];
  if (!manualGrantMethod) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={type} size={20} />
            <DialogTitle>{config.label}</DialogTitle>
          </div>
        </DialogHeader>
        <ManualGrantForm
          type={type}
          manualGrantMethod={manualGrantMethod}
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
  disabled,
  onConnect,
}: {
  isConnected: boolean;
  isConnecting: boolean;
  disabled: boolean;
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
          disabled={isConnecting || disabled}
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
      disabled={isConnecting || disabled}
      onClick={onConnect}
      className="inline-flex h-9 w-[100px] items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
    >
      {isConnecting && <IconLoader2 size={14} className="animate-spin" />}
      {isConnecting ? "Connecting..." : "Connect"}
    </button>
  );
}

function DirectedConnectModal({
  open,
  onClose,
  onSuccess,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => Promise<void>;
}) {
  if (!open) {
    return null;
  }
  return <ConnectModal onClose={onClose} onSuccess={onSuccess} />;
}

function DirectedConnectDialogs({
  connectorType,
  manualGrantMethod,
  manualGrantDialogOpen,
  setManualGrantDialogOpen,
  agentId,
  runPostConnectActions,
  selectedConnectorType,
  setSelectedConnectorType,
}: {
  readonly connectorType: ConnectorType;
  readonly manualGrantMethod: ManualGrantMethod | null;
  readonly manualGrantDialogOpen: boolean;
  readonly setManualGrantDialogOpen: (open: boolean) => void;
  readonly agentId: string | null | undefined;
  readonly runPostConnectActions: () => Promise<void>;
  readonly selectedConnectorType: ConnectorType | null;
  readonly setSelectedConnectorType: (type: ConnectorType | null) => void;
}) {
  return (
    <>
      <ManualGrantDialog
        type={connectorType}
        manualGrantMethod={manualGrantMethod}
        open={manualGrantDialogOpen}
        onOpenChange={setManualGrantDialogOpen}
        onConnected={
          agentId
            ? () => {
                detach(runPostConnectActions(), Reason.DomCallback);
              }
            : undefined
        }
      />
      <DirectedConnectModal
        open={selectedConnectorType === connectorType}
        onClose={() => {
          setSelectedConnectorType(null);
        }}
        onSuccess={runPostConnectActions}
      />
    </>
  );
}

function useDirectedConnectConnectorType(): ConnectorType | null {
  const type = useGet(directedConnectType$);
  if (!type) {
    return null;
  }
  const parsed = connectorTypeSchema.safeParse(type);
  return parsed.success ? parsed.data : null;
}

function DirectedConnectCard() {
  const connectorType = useDirectedConnectConnectorType();
  const agentId = useGet(directedConnectAgentId$);
  const agentNameLoadable = useLastLoadable(directedConnectAgentName$);
  const pollingAuthCodeType = useGet(pollingOAuthAuthCodeConnectorType$);
  const pollingDeviceAuthType = useGet(pollingOAuthDeviceAuthConnectorType$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const authorize = useSet(authorizeConnector$);
  const signal = useGet(pageSignal$);
  const justConnected = useGet(justConnectedTypes$);
  const allLoadable = useLastLoadable(allConnectorTypes$);
  const manualGrantDialogOpen = useGet(manualGrantDialogOpen$);
  const setManualGrantDialogOpen = useSet(setManualGrantDialogOpen$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelectedConnectorType = useSet(setSelectedConnectorType$);

  if (!connectorType) {
    return null;
  }

  const config = CONNECTOR_TYPES[connectorType];
  const agentName =
    agentNameLoadable.state === "hasData" && agentNameLoadable.data
      ? agentNameLoadable.data
      : "Zero";
  const isConnecting =
    pollingAuthCodeType === connectorType ||
    pollingDeviceAuthType === connectorType;
  const isLoading =
    !justConnected.has(connectorType) && allLoadable.state === "loading";
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data : [];
  const item = allData.find((c) => {
    return c.type === connectorType;
  });
  const unavailable =
    catalogLoaded && !item && !justConnected.has(connectorType);
  if (unavailable) {
    return null;
  }
  const isConnected =
    justConnected.has(connectorType) || (item?.connected ?? false);
  const authMethods = item?.availableAuthMethods ?? [];
  const manualGrantMethod = getManualGrantMethod(connectorType, authMethods);
  const canConnect = authMethods.length > 0;

  const runPostConnectActions = async () => {
    if (agentId) {
      await authorize(connectorType, agentId, signal);
    }
  };

  const handleConnect = () => {
    if (!canConnect) {
      return;
    }
    runDirectedConnect({
      authMethods,
      connectorType,
      signal,
      connect,
      onConnected: runPostConnectActions,
      openManualGrantDialog: () => {
        return setManualGrantDialogOpen(true);
      },
      openConnectModal: () => {
        setSelectedConnectorType(connectorType);
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
                  disabled={!canConnect}
                  onConnect={handleConnect}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <DirectedConnectDialogs
        connectorType={connectorType}
        manualGrantMethod={manualGrantMethod}
        manualGrantDialogOpen={manualGrantDialogOpen}
        setManualGrantDialogOpen={setManualGrantDialogOpen}
        agentId={agentId}
        runPostConnectActions={runPostConnectActions}
        selectedConnectorType={selectedConnectorType}
        setSelectedConnectorType={setSelectedConnectorType}
      />
    </>
  );
}

export function ZeroDirectedConnectPage() {
  return <DirectedConnectCard />;
}
