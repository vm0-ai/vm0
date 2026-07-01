import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  connectorTypeSchema,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
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
  getOnlyAvailableStatusAuthCodeAuthMethod,
  getConnectorStatusConnectLaunchMode,
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
  getOnlyManualConnectorStatusAuthMethod,
  hasConnectorStatusProviderDrivenConnectMethod,
  manualGrantInputValuesForMethod,
  type ConnectorTypeWithStatus,
  type ConnectorStatusAuthMethodDetail,
} from "../../signals/zero-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../signals/zero-page/settings/token-input.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
  withCleanup,
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
import {
  Vm0LogoLink,
  GoogleSecurityWarningNotice,
} from "./zero-directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import type { FormEvent } from "react";
import { ConnectorHelpText } from "./components/settings/connector-help-text.tsx";

function runDirectedConnect(params: {
  item: ConnectorTypeWithStatus;
  connectorType: ConnectorType;
  signal: AbortSignal;
  connect: (
    type: ConnectorType,
    authMethod: ConnectorAuthMethodId,
    options: {
      readonly showPermissionDialog?: boolean;
      readonly connectorLabel?: string;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  onConnected: () => Promise<void>;
  openConnectModal: () => void;
  openManualGrantDialog: () => void;
}): void {
  const launchMode = getConnectorStatusConnectLaunchMode(params.item);
  if (
    launchMode === "modal" &&
    hasConnectorStatusProviderDrivenConnectMethod(params.item)
  ) {
    params.openConnectModal();
    return;
  }

  const manualGrantMethod = getOnlyManualConnectorStatusAuthMethod(params.item);

  if (launchMode === "modal" && manualGrantMethod) {
    params.openManualGrantDialog();
    return;
  }
  if (launchMode === "modal") {
    params.openConnectModal();
    return;
  }

  const authMethod = getOnlyAvailableStatusAuthCodeAuthMethod(params.item);
  if (!authMethod) {
    params.openConnectModal();
    return;
  }

  detach(
    (async () => {
      let connected = true;
      connected = await params.connect(
        params.connectorType,
        authMethod,
        { connectorLabel: params.item.label },
        params.signal,
      );
      if (connected) {
        await params.onConnected();
      }
    })(),
    Reason.DomCallback,
  );
}

function ManualGrantForm({
  type,
  connectorLabel,
  manualGrantMethod,
  onSuccess,
}: {
  type: ConnectorType;
  connectorLabel: string;
  manualGrantMethod: ConnectorStatusAuthMethodDetail;
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

  const allFilled = manualGrantMethod.manualFields.every((field) => {
    return !field.required || hasTokenInputValue(fieldValues[field.id]);
  });

  const handleSubmit = onDomEventFn(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!allFilled || submitting) {
        return;
      }
      setSubmitting(type);
      await withCleanup(
        bestEffort(
          (async () => {
            const connected = await submit(
              {
                type,
                authMethod: manualGrantMethod.id,
                inputValues: manualGrantInputValuesForMethod(
                  manualGrantMethod,
                  fieldValues,
                ),
                options: { connectorLabel },
              },
              pageSignal,
            );
            if (!connected) {
              return;
            }
            clearForm(type);
            onSuccess();
          })(),
        ),
        () => {
          setSubmitting(null);
        },
      );
    },
  );

  return (
    <form
      className="flex w-full flex-col gap-3 text-left"
      onSubmit={handleSubmit}
    >
      {manualGrantMethod.description && (
        <ConnectorHelpText text={manualGrantMethod.description} />
      )}
      {manualGrantMethod.manualFields.map((fieldConfig) => {
        return (
          <div key={fieldConfig.id} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {fieldConfig.label}
            </label>
            <Input
              type={fieldConfig.inputType}
              placeholder={fieldConfig.placeholder ?? undefined}
              value={fieldValues[fieldConfig.id] ?? ""}
              onChange={(e) => {
                return setFormValue(type, fieldConfig.id, e.target.value);
              }}
            />
          </div>
        );
      })}
      <button
        type="submit"
        disabled={!allFilled || submitting}
        className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
      >
        {submitting && <IconLoader2 size={14} className="animate-spin" />}
        {submitting ? "Saving..." : "Save"}
      </button>
    </form>
  );
}

function ManualGrantDialog({
  type,
  connectorLabel,
  manualGrantMethod,
  open,
  onOpenChange,
  onConnected,
}: {
  type: ConnectorType;
  connectorLabel: string;
  manualGrantMethod: ConnectorStatusAuthMethodDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}) {
  if (!manualGrantMethod) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={type} size={20} />
            <DialogTitle>{connectorLabel}</DialogTitle>
          </div>
        </DialogHeader>
        <ManualGrantForm
          type={type}
          connectorLabel={connectorLabel}
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
  connectorLabel,
  manualGrantMethod,
  manualGrantDialogOpen,
  setManualGrantDialogOpen,
  agentId,
  runPostConnectActions,
  selectedConnectorType,
  setSelectedConnectorType,
}: {
  readonly connectorType: ConnectorType;
  readonly connectorLabel: string;
  readonly manualGrantMethod: ConnectorStatusAuthMethodDetail | null;
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
        connectorLabel={connectorLabel}
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

function ConnectorConnectNotices({
  connectNotice,
  isConnected,
}: {
  readonly connectNotice: ConnectorTypeWithStatus["connectNotice"] | null;
  readonly isConnected: boolean;
}) {
  if (isConnected) {
    return null;
  }
  if (connectNotice === "google-security-warning") {
    return <GoogleSecurityWarningNotice />;
  }
  return null;
}

function useDirectedConnectCatalogState(connectorType: ConnectorType | null): {
  readonly item: ConnectorTypeWithStatus | undefined;
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  readonly unavailable: boolean;
} {
  const justConnected = useGet(justConnectedTypes$);
  const allLoadable = useLastLoadable(allConnectorTypes$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data : [];
  const item = connectorType
    ? allData.find((connector) => {
        return connector.type === connectorType;
      })
    : undefined;
  const optimisticallyConnected =
    connectorType !== null && justConnected.has(connectorType);
  const isConnected = optimisticallyConnected || (item?.connected ?? false);
  return {
    item,
    isConnected,
    isLoading:
      connectorType !== null &&
      !optimisticallyConnected &&
      allLoadable.state === "loading",
    unavailable:
      connectorType !== null &&
      catalogLoaded &&
      !item &&
      !optimisticallyConnected,
  };
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
  const { item, isConnected, isLoading, unavailable } =
    useDirectedConnectCatalogState(connectorType);
  const manualGrantDialogOpen = useGet(manualGrantDialogOpen$);
  const setManualGrantDialogOpen = useSet(setManualGrantDialogOpen$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelectedConnectorType = useSet(setSelectedConnectorType$);

  if (!connectorType) {
    return null;
  }

  const agentName =
    agentNameLoadable.state === "hasData" &&
    agentNameLoadable.data.agentId === agentId &&
    agentNameLoadable.data.displayName
      ? agentNameLoadable.data.displayName
      : "Zero";
  const isConnecting =
    pollingAuthCodeType === connectorType ||
    pollingDeviceAuthType === connectorType;
  if (unavailable) {
    return null;
  }
  const authMethods = item?.availableAuthMethods ?? [];
  const manualGrantMethod = item
    ? getOnlyManualConnectorStatusAuthMethod(item)
    : null;
  const canConnect = authMethods.length > 0;
  const connectorLabel = item?.label ?? connectorType;
  const connectorDescription = item?.helpText ?? "";

  const runPostConnectActions = async () => {
    if (agentId) {
      await authorize(connectorType, agentId, signal);
    }
  };

  const handleConnect = () => {
    if (!canConnect || !item) {
      return;
    }
    runDirectedConnect({
      item,
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
                      ? `${connectorLabel} connected`
                      : `${agentName} needs ${connectorLabel} to proceed`}
                  </h1>
                  <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
                    <ConnectorIcon type={connectorType} size={20} />
                  </div>
                  <p className="w-60 text-sm text-muted-foreground">
                    {connectorDescription}
                  </p>
                  <ConnectorConnectNotices
                    connectNotice={item?.connectNotice ?? null}
                    isConnected={isConnected}
                  />
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
        connectorLabel={connectorLabel}
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
