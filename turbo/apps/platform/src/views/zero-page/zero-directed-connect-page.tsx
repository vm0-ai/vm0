import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  connectorRefSchema,
  type ConnectorAuthMethodId,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorCatalogItems$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowConnectorRef$,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  getConnectorStatusConnectLaunchMode,
  justConnectedRefs$,
  pollingOAuthAuthCodeConnectorRef$,
  pollingOAuthDeviceAuthConnectorRef$,
  submitManualGrant$,
  manualGrantFormSubmitting$,
  setManualGrantFormValue$,
  clearManualGrantForm$,
  manualGrantFormValuesFor$,
  setManualGrantFormSubmitting$,
  getOnlyManualConnectorStatusAuthMethod,
  hasConnectorStatusProviderDrivenConnectMethod,
  manualGrantInputValuesForMethod,
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
  directedConnectRef$,
  directedConnectAgentId$,
  directedConnectAgentName$,
  manualGrantDialogKey$,
  setManualGrantDialogKey$,
  directedConnectModalKey$,
  setDirectedConnectModalKey$,
  type DirectedConnectModalKey,
  type DirectedConnectManualGrantDialogKey,
} from "../../signals/connectors-page/directed-connect-ref.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Vm0LogoLink } from "./zero-directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import type { FormEvent } from "react";
import { ConnectorHelpText } from "./components/settings/connector-help-text.tsx";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
} from "../../signals/chat-page/action-callback.ts";

function runDirectedConnect(params: {
  item: PublicConnectorCatalogStatusItem;
  connectorRef: ConnectorRef;
  agentId: string | null;
  signal: AbortSignal;
  connect: (
    connectorRef: ConnectorRef,
    method: PublicConnectorCatalogAuthMethodDetail,
    options: {
      readonly connectorLabel?: string;
      readonly agentId?: string;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  connectNoAuth: (
    args: {
      readonly connectorRef: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly options: {
        readonly connectorLabel?: string;
        readonly agentId?: string;
      };
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  openConnectModal: () => void;
  openManualGrantDialog: () => void;
  onSuccess: () => void | Promise<void>;
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

  if (
    launchMode === "modal" &&
    manualGrantMethod &&
    params.item.authMethods.length === 1
  ) {
    params.openManualGrantDialog();
    return;
  }
  if (launchMode === "modal") {
    params.openConnectModal();
    return;
  }

  detach(
    (async () => {
      if (launchMode === "browser-auth") {
        const authMethod = getOnlyAvailableStatusBrowserAuthMethodDetail(
          params.item,
        );
        if (!authMethod) {
          params.openConnectModal();
          return;
        }
        const connected = await params.connect(
          params.connectorRef,
          authMethod,
          {
            connectorLabel: params.item.label,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          },
          params.signal,
        );
        if (connected) {
          await params.onSuccess();
        }
      } else {
        const authMethod = getOnlyAvailableStatusNoAuthMethod(params.item);
        if (!authMethod) {
          params.openConnectModal();
          return;
        }
        const connected = await params.connectNoAuth(
          {
            connectorRef: params.connectorRef,
            authMethod,
            options: {
              connectorLabel: params.item.label,
              ...(params.agentId ? { agentId: params.agentId } : {}),
            },
          },
          params.signal,
        );
        if (connected) {
          await params.onSuccess();
        }
      }
    })(),
    Reason.DomCallback,
  );
}

function ManualGrantForm({
  connectorRef,
  agentId,
  connectorLabel,
  manualGrantMethod,
  onSuccess,
}: {
  connectorRef: ConnectorRef;
  agentId: string | null;
  connectorLabel: string;
  manualGrantMethod: PublicConnectorCatalogAuthMethodDetail;
  onSuccess: () => void | Promise<void>;
}) {
  const submit = useSet(submitManualGrant$);
  const setFormValue = useSet(setManualGrantFormValue$);
  const clearForm = useSet(clearManualGrantForm$);
  const pageSignal = useGet(pageSignal$);
  const manualGrantFormValuesFor = useGet(manualGrantFormValuesFor$);
  const fieldValues = manualGrantFormValuesFor(connectorRef);
  const submittingRef = useGet(manualGrantFormSubmitting$);
  const setSubmitting = useSet(setManualGrantFormSubmitting$);
  const submitting = submittingRef === connectorRef;

  const allFilled = manualGrantMethod.manualFields.every((field) => {
    return !field.required || hasTokenInputValue(fieldValues[field.id]);
  });

  const handleSubmit = onDomEventFn(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!allFilled || submitting) {
        return;
      }
      setSubmitting(connectorRef);
      await withCleanup(
        bestEffort(
          (async () => {
            const connected = await submit(
              {
                connectorRef,
                authMethod: manualGrantMethod.id,
                inputValues: manualGrantInputValuesForMethod(
                  manualGrantMethod,
                  fieldValues,
                ),
                options: {
                  connectorLabel,
                  ...(agentId ? { agentId } : {}),
                },
              },
              pageSignal,
            );
            if (!connected) {
              return;
            }
            await onSuccess();
            clearForm(connectorRef);
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
                return setFormValue(
                  connectorRef,
                  fieldConfig.id,
                  e.target.value,
                );
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
  connectorRef,
  agentId,
  icon,
  connectorLabel,
  manualGrantMethod,
  open,
  onOpenChange,
  onSuccess,
}: {
  connectorRef: ConnectorRef;
  agentId: string | null;
  icon: PublicConnectorCatalogStatusItem["icon"] | undefined;
  connectorLabel: string;
  manualGrantMethod: PublicConnectorCatalogAuthMethodDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}) {
  if (!manualGrantMethod) {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon icon={icon} size={20} />
            <DialogTitle>{connectorLabel}</DialogTitle>
          </div>
        </DialogHeader>
        <ManualGrantForm
          connectorRef={connectorRef}
          agentId={agentId}
          connectorLabel={connectorLabel}
          manualGrantMethod={manualGrantMethod}
          onSuccess={async () => {
            await onSuccess();
            onOpenChange(false);
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
  connectorRef,
  agentId,
  onClose,
  onSuccess,
}: {
  readonly open: boolean;
  readonly connectorRef: ConnectorRef;
  readonly agentId: string | null;
  readonly onClose: () => void;
  readonly onSuccess: () => void | Promise<void>;
}) {
  if (!open) {
    return null;
  }
  return (
    <ConnectModal
      selectedConnectorRef={connectorRef}
      {...(agentId ? { agentId } : {})}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

function DirectedConnectDialogs({
  connectorRef,
  icon,
  connectorLabel,
  manualGrantMethod,
  manualGrantDialogOpen,
  setManualGrantDialogOpen,
  agentId,
  connectModalOpen,
  setConnectModalOpen,
  onSuccess,
}: {
  readonly connectorRef: ConnectorRef;
  readonly icon: PublicConnectorCatalogStatusItem["icon"] | undefined;
  readonly connectorLabel: string;
  readonly manualGrantMethod: PublicConnectorCatalogAuthMethodDetail | null;
  readonly manualGrantDialogOpen: boolean;
  readonly setManualGrantDialogOpen: (open: boolean) => void;
  readonly agentId: string | null | undefined;
  readonly connectModalOpen: boolean;
  readonly setConnectModalOpen: (open: boolean) => void;
  readonly onSuccess: () => void | Promise<void>;
}) {
  return (
    <>
      <ManualGrantDialog
        connectorRef={connectorRef}
        agentId={agentId ?? null}
        icon={icon}
        connectorLabel={connectorLabel}
        manualGrantMethod={manualGrantMethod}
        open={manualGrantDialogOpen}
        onOpenChange={setManualGrantDialogOpen}
        onSuccess={onSuccess}
      />
      <DirectedConnectModal
        open={connectModalOpen}
        connectorRef={connectorRef}
        agentId={agentId ?? null}
        onClose={() => {
          setConnectModalOpen(false);
        }}
        onSuccess={onSuccess}
      />
    </>
  );
}

function useDirectedConnectConnectorRef(): ConnectorRef | null {
  const routeType = useGet(directedConnectRef$);
  if (!routeType) {
    return null;
  }
  const parsed = connectorRefSchema.safeParse(routeType);
  return parsed.success ? parsed.data : null;
}

function useDirectedConnectCatalogState(connectorRef: ConnectorRef | null): {
  readonly item: PublicConnectorCatalogStatusItem | undefined;
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  readonly unavailable: boolean;
} {
  const justConnected = useGet(justConnectedRefs$);
  const allLoadable = useLastLoadable(allConnectorCatalogItems$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data : [];
  const item = connectorRef
    ? allData.find((connector) => {
        return connector.connectorRef === connectorRef;
      })
    : undefined;
  const optimisticallyConnected =
    connectorRef !== null && justConnected.has(connectorRef);
  const isConnected = optimisticallyConnected || (item?.connected ?? false);
  return {
    item,
    isConnected,
    isLoading:
      connectorRef !== null &&
      !optimisticallyConnected &&
      allLoadable.state === "loading",
    unavailable:
      connectorRef !== null &&
      catalogLoaded &&
      !item &&
      !optimisticallyConnected,
  };
}

function directedConnectManualGrantDialogOpen(
  key: DirectedConnectManualGrantDialogKey | null,
  args: {
    readonly connectorRef: ConnectorRef | null;
    readonly agentId: string | null;
    readonly signal: AbortSignal;
  },
): boolean {
  return (
    key?.connectorRef === args.connectorRef &&
    key.agentId === args.agentId &&
    key.signal === args.signal
  );
}

function directedConnectModalOpen(
  key: DirectedConnectModalKey | null,
  args: {
    readonly connectorRef: ConnectorRef | null;
    readonly agentId: string | null;
    readonly signal: AbortSignal;
  },
): boolean {
  return (
    key?.connectorRef === args.connectorRef &&
    key.agentId === args.agentId &&
    key.signal === args.signal
  );
}

function DirectedConnectCardContent({
  icon,
  connectorLabel,
  connectorDescription,
  agentName,
  isLoading,
  isConnected,
  isConnecting,
  canConnect,
  onConnect,
}: {
  readonly icon: PublicConnectorCatalogStatusItem["icon"] | undefined;
  readonly connectorLabel: string;
  readonly connectorDescription: string;
  readonly agentName: string;
  readonly isLoading: boolean;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly canConnect: boolean;
  readonly onConnect: () => void;
}) {
  return (
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
                  <ConnectorIcon icon={icon} size={20} />
                </div>
                <p className="w-60 text-sm text-muted-foreground">
                  {connectorDescription}
                </p>
              </>
            )}
          </div>
          {!isLoading && (
            <div className="flex flex-col items-center justify-center gap-2">
              <ConnectActions
                isConnected={isConnected}
                isConnecting={isConnecting}
                disabled={!canConnect}
                onConnect={onConnect}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DirectedConnectCard() {
  const connectorRef = useDirectedConnectConnectorRef();
  const agentId = useGet(directedConnectAgentId$);
  const agentNameLoadable = useLastLoadable(directedConnectAgentName$);
  const pollingAuthCodeRef = useGet(pollingOAuthAuthCodeConnectorRef$);
  const pollingDeviceAuthRef = useGet(pollingOAuthDeviceAuthConnectorRef$);
  const connectFlowRef = useGet(connectFlowConnectorRef$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const signal = useGet(pageSignal$);
  const { item, isConnected, isLoading, unavailable } =
    useDirectedConnectCatalogState(connectorRef);
  const manualGrantDialogKey = useGet(manualGrantDialogKey$);
  const setManualGrantDialogKey = useSet(setManualGrantDialogKey$);
  const connectModalKey = useGet(directedConnectModalKey$);
  const setDirectedConnectModalKey = useSet(setDirectedConnectModalKey$);
  const actionCallback = useGet(routeChatActionCallback$);
  const runCallback = useSet(runChatActionCallback$);
  const manualGrantDialogOpen = directedConnectManualGrantDialogOpen(
    manualGrantDialogKey,
    { connectorRef, agentId, signal },
  );
  const connectModalOpen = directedConnectModalOpen(connectModalKey, {
    connectorRef,
    agentId,
    signal,
  });

  if (!connectorRef) {
    return null;
  }

  const agentName =
    agentNameLoadable.state === "hasData" &&
    agentNameLoadable.data.agentId === agentId &&
    agentNameLoadable.data.displayName
      ? agentNameLoadable.data.displayName
      : "Zero";
  const isConnecting =
    pollingAuthCodeRef === connectorRef ||
    pollingDeviceAuthRef === connectorRef ||
    connectFlowRef === connectorRef;
  if (unavailable) {
    return null;
  }
  const authMethods = item?.authMethods ?? [];
  const manualGrantMethod = item
    ? getOnlyManualConnectorStatusAuthMethod(item)
    : null;
  const canConnect = authMethods.length > 0;
  const connectorLabel = item?.label ?? connectorRef;
  const connectorDescription = item?.description ?? "";
  const handleConnectSuccess = async () => {
    if (actionCallback.callbackPrompt && actionCallback.threadId && agentId) {
      await runCallback(
        {
          threadId: actionCallback.threadId,
          agentId,
          callbackPrompt: actionCallback.callbackPrompt,
        },
        signal,
      );
    }
  };

  const handleConnect = () => {
    if (!canConnect || !item) {
      return;
    }
    runDirectedConnect({
      item,
      connectorRef,
      agentId,
      signal,
      connect,
      connectNoAuth,
      openManualGrantDialog: () => {
        return setManualGrantDialogKey({
          connectorRef,
          agentId,
          signal,
        });
      },
      openConnectModal: () => {
        setDirectedConnectModalKey({
          connectorRef,
          agentId,
          signal,
        });
      },
      onSuccess: handleConnectSuccess,
    });
  };

  return (
    <>
      <DirectedConnectCardContent
        icon={item?.icon}
        connectorLabel={connectorLabel}
        connectorDescription={connectorDescription}
        agentName={agentName}
        isLoading={isLoading}
        isConnected={isConnected}
        isConnecting={isConnecting}
        canConnect={canConnect}
        onConnect={handleConnect}
      />
      <DirectedConnectDialogs
        connectorRef={connectorRef}
        icon={item?.icon}
        connectorLabel={connectorLabel}
        manualGrantMethod={manualGrantMethod}
        manualGrantDialogOpen={manualGrantDialogOpen}
        setManualGrantDialogOpen={(open) => {
          setManualGrantDialogKey(
            open ? { connectorRef, agentId, signal } : null,
          );
        }}
        agentId={agentId}
        connectModalOpen={connectModalOpen}
        setConnectModalOpen={(open) => {
          setDirectedConnectModalKey(
            open ? { connectorRef, agentId, signal } : null,
          );
        }}
        onSuccess={handleConnectSuccess}
      />
    </>
  );
}

export function ZeroDirectedConnectPage() {
  return <DirectedConnectCard />;
}
