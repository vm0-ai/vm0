import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogAuthMethodDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
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
  connectFlowConnectorSlug$,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  getConnectorStatusConnectLaunchMode,
  justConnectedSlugs$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
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
  directedConnectSlug$,
  directedConnectAgentId$,
  directedConnectAgentName$,
  manualGrantDialogKey$,
  setManualGrantDialogKey$,
  directedConnectModalKey$,
  setDirectedConnectModalKey$,
  type DirectedConnectModalKey,
  type DirectedConnectManualGrantDialogKey,
} from "../../signals/connectors-page/directed-connect-slug.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Vm0LogoLink } from "./zero-directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorHelpText } from "./components/settings/connector-help-text.tsx";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
} from "../../signals/chat-page/action-callback.ts";

function runDirectedConnect(params: {
  item: PlatformConnectorCatalogStatusItem;
  connectorSlug: ConnectorSlug;
  agentId: string | null;
  signal: AbortSignal;
  connect: (
    connectorSlug: ConnectorSlug,
    method: PublicConnectorCatalogAuthMethodDetail,
    options: {
      readonly connectorLabel?: string;
      readonly connectorIcon: PlatformConnectorCatalogStatusItem["icon"];
      readonly agentId?: string;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  connectNoAuth: (
    args: {
      readonly connectorSlug: ConnectorSlug;
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
          params.connectorSlug,
          authMethod,
          {
            connectorLabel: params.item.label,
            connectorIcon: params.item.icon,
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
            connectorSlug: params.connectorSlug,
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
  connectorSlug,
  agentId,
  connectorLabel,
  manualGrantMethod,
  onSuccess,
}: {
  connectorSlug: ConnectorSlug;
  agentId: string | null;
  connectorLabel: string;
  manualGrantMethod: PublicConnectorCatalogAuthMethodDetail;
  onSuccess: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const submit = useSet(submitManualGrant$);
  const setFormValue = useSet(setManualGrantFormValue$);
  const clearForm = useSet(clearManualGrantForm$);
  const pageSignal = useGet(pageSignal$);
  const manualGrantFormValuesFor = useGet(manualGrantFormValuesFor$);
  const fieldValues = manualGrantFormValuesFor(connectorSlug);
  const submittingSlug = useGet(manualGrantFormSubmitting$);
  const setSubmitting = useSet(setManualGrantFormSubmitting$);
  const submitting = submittingSlug === connectorSlug;

  const allFilled = manualGrantMethod.manualFields.every((field) => {
    return !field.required || hasTokenInputValue(fieldValues[field.id]);
  });

  const handleSubmit = onDomEventFn(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!allFilled || submitting) {
        return;
      }
      setSubmitting(connectorSlug);
      await withCleanup(
        bestEffort(
          (async () => {
            const connected = await submit(
              {
                connectorSlug,
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
            clearForm(connectorSlug);
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
                  connectorSlug,
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
        {submitting
          ? t(($) => {
              return $.connectors.actions.saving;
            })
          : t(($) => {
              return $.connectors.actions.save;
            })}
      </button>
    </form>
  );
}

function ManualGrantDialog({
  connectorSlug,
  agentId,
  icon,
  connectorLabel,
  manualGrantMethod,
  open,
  onOpenChange,
  onSuccess,
}: {
  connectorSlug: ConnectorSlug;
  agentId: string | null;
  icon: PlatformConnectorCatalogStatusItem["icon"] | undefined;
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
          connectorSlug={connectorSlug}
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
  const { t } = useTranslation();
  if (isConnected) {
    return (
      <>
        <div className="inline-flex h-9 w-[100px] items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
          <IconCheck size={16} />
          {t(($) => {
            return $.connectors.card.connected;
          })}
        </div>
        <button
          type="button"
          disabled={isConnecting || disabled}
          onClick={onConnect}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60 inline-flex items-center gap-1.5"
        >
          {isConnecting && <IconLoader2 size={12} className="animate-spin" />}
          {isConnecting
            ? t(($) => {
                return $.connectors.directed.reconnecting;
              })
            : t(($) => {
                return $.connectors.actions.reconnect;
              })}
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
      {isConnecting
        ? t(($) => {
            return $.connectors.actions.connecting;
          })
        : t(($) => {
            return $.connectors.actions.connect;
          })}
    </button>
  );
}

function DirectedConnectModal({
  open,
  connectorSlug,
  agentId,
  onClose,
  onSuccess,
}: {
  readonly open: boolean;
  readonly connectorSlug: ConnectorSlug;
  readonly agentId: string | null;
  readonly onClose: () => void;
  readonly onSuccess: () => void | Promise<void>;
}) {
  if (!open) {
    return null;
  }
  return (
    <ConnectModal
      selectedConnectorSlug={connectorSlug}
      {...(agentId ? { agentId } : {})}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

function DirectedConnectDialogs({
  connectorSlug,
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
  readonly connectorSlug: ConnectorSlug;
  readonly icon: PlatformConnectorCatalogStatusItem["icon"] | undefined;
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
        connectorSlug={connectorSlug}
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
        connectorSlug={connectorSlug}
        agentId={agentId ?? null}
        onClose={() => {
          setConnectModalOpen(false);
        }}
        onSuccess={onSuccess}
      />
    </>
  );
}

function useDirectedConnectConnectorSlug(): ConnectorSlug | null {
  const connectorSlug = useGet(directedConnectSlug$);
  if (!connectorSlug) {
    return null;
  }
  const parsed = connectorSlugSchema.safeParse(connectorSlug);
  return parsed.success ? parsed.data : null;
}

function useDirectedConnectCatalogState(connectorSlug: ConnectorSlug | null): {
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly isConnected: boolean;
  readonly isLoading: boolean;
  readonly unavailable: boolean;
} {
  const justConnected = useGet(justConnectedSlugs$);
  const allLoadable = useLastLoadable(allConnectorCatalogItems$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data : [];
  const item = connectorSlug
    ? allData.find((connector) => {
        return connector.slug === connectorSlug;
      })
    : undefined;
  const optimisticallyConnected =
    connectorSlug !== null && justConnected.has(connectorSlug);
  const isConnected = optimisticallyConnected || (item?.connected ?? false);
  return {
    item,
    isConnected,
    isLoading:
      connectorSlug !== null &&
      !optimisticallyConnected &&
      allLoadable.state === "loading",
    unavailable:
      connectorSlug !== null &&
      catalogLoaded &&
      !item &&
      !optimisticallyConnected,
  };
}

function directedConnectManualGrantDialogOpen(
  key: DirectedConnectManualGrantDialogKey | null,
  args: {
    readonly connectorSlug: ConnectorSlug | null;
    readonly agentId: string | null;
    readonly signal: AbortSignal;
  },
): boolean {
  return (
    key?.connectorSlug === args.connectorSlug &&
    key.agentId === args.agentId &&
    key.signal === args.signal
  );
}

function directedConnectModalOpen(
  key: DirectedConnectModalKey | null,
  args: {
    readonly connectorSlug: ConnectorSlug | null;
    readonly agentId: string | null;
    readonly signal: AbortSignal;
  },
): boolean {
  return (
    key?.connectorSlug === args.connectorSlug &&
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
  readonly icon: PlatformConnectorCatalogStatusItem["icon"] | undefined;
  readonly connectorLabel: string;
  readonly connectorDescription: string;
  readonly agentName: string;
  readonly isLoading: boolean;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly canConnect: boolean;
  readonly onConnect: () => void;
}) {
  const { t } = useTranslation();
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
                    ? t(
                        ($) => {
                          return $.connectors.directed.connected;
                        },
                        { connector: connectorLabel },
                      )
                    : t(
                        ($) => {
                          return $.connectors.directed.needsConnector;
                        },
                        { agent: agentName, connector: connectorLabel },
                      )}
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
  const connectorSlug = useDirectedConnectConnectorSlug();
  const agentId = useGet(directedConnectAgentId$);
  const agentNameLoadable = useLastLoadable(directedConnectAgentName$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const signal = useGet(pageSignal$);
  const { item, isConnected, isLoading, unavailable } =
    useDirectedConnectCatalogState(connectorSlug);
  const manualGrantDialogKey = useGet(manualGrantDialogKey$);
  const setManualGrantDialogKey = useSet(setManualGrantDialogKey$);
  const connectModalKey = useGet(directedConnectModalKey$);
  const setDirectedConnectModalKey = useSet(setDirectedConnectModalKey$);
  const actionCallback = useGet(routeChatActionCallback$);
  const runCallback = useSet(runChatActionCallback$);
  const manualGrantDialogOpen = directedConnectManualGrantDialogOpen(
    manualGrantDialogKey,
    { connectorSlug, agentId, signal },
  );
  const connectModalOpen = directedConnectModalOpen(connectModalKey, {
    connectorSlug,
    agentId,
    signal,
  });

  if (!connectorSlug) {
    return null;
  }

  const agentName =
    agentNameLoadable.state === "hasData" &&
    agentNameLoadable.data.agentId === agentId &&
    agentNameLoadable.data.displayName
      ? agentNameLoadable.data.displayName
      : "Zero";
  const isConnecting =
    pollingAuthCodeSlug === connectorSlug ||
    pollingDeviceAuthSlug === connectorSlug ||
    connectFlowSlug === connectorSlug;
  if (unavailable) {
    return null;
  }
  const authMethods = item?.authMethods ?? [];
  const manualGrantMethod = item
    ? getOnlyManualConnectorStatusAuthMethod(item)
    : null;
  const canConnect = authMethods.length > 0;
  const connectorLabel = item?.label ?? connectorSlug;
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
      connectorSlug,
      agentId,
      signal,
      connect,
      connectNoAuth,
      openManualGrantDialog: () => {
        return setManualGrantDialogKey({
          connectorSlug,
          agentId,
          signal,
        });
      },
      openConnectModal: () => {
        setDirectedConnectModalKey({
          connectorSlug,
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
        connectorSlug={connectorSlug}
        icon={item?.icon}
        connectorLabel={connectorLabel}
        manualGrantMethod={manualGrantMethod}
        manualGrantDialogOpen={manualGrantDialogOpen}
        setManualGrantDialogOpen={(open) => {
          setManualGrantDialogKey(
            open ? { connectorSlug, agentId, signal } : null,
          );
        }}
        agentId={agentId}
        connectModalOpen={connectModalOpen}
        setConnectModalOpen={(open) => {
          setDirectedConnectModalKey(
            open ? { connectorSlug, agentId, signal } : null,
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
