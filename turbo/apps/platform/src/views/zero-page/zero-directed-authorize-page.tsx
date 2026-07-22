import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  connectorRefSchema,
  type ConnectorAuthMethodId,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorTypes$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowType$,
  getConnectorStatusConnectLaunchMode,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  justConnectedTypes$,
  pollingOAuthAuthCodeConnectorType$,
  type ConnectorStatusAuthMethodDetail,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  directedAuthorizeType$,
  directedAuthorizeAgentId$,
  directedAuthorizeAgentName$,
  agentEnabledTypes$,
  justAuthorizedConnectorAgentKeys$,
  authorizeConnector$,
  isJustAuthorizedConnectorAgent,
  directedAuthorizeConnectModalKey$,
  setDirectedAuthorizeConnectModalKey$,
  type DirectedAuthorizeConnectModalKey,
} from "../../signals/connectors-page/directed-authorize-type.ts";
import {
  routeChatActionCallback$,
  runChatActionCallback$,
} from "../../signals/chat-page/action-callback.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { reloadAgentConnectorAuthorizations$ } from "../../signals/zero-page/agent-connector-authorizations.ts";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Vm0LogoLink } from "./zero-directed-shared.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";

// ---------------------------------------------------------------------------
// Action button / authorized badge
// ---------------------------------------------------------------------------

function AuthorizeAction({
  isAuthorized,
  isConnecting,
  disabled,
  agentName,
  onAuthorize,
}: {
  isAuthorized: boolean;
  isConnecting: boolean;
  disabled: boolean;
  agentName: string;
  onAuthorize: () => void;
}) {
  if (isAuthorized) {
    return (
      <div className="inline-flex h-9 w-[140px] items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
        <IconCheck size={16} />
        Authorized
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={isConnecting || disabled}
      onClick={onAuthorize}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] px-4 text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
    >
      {isConnecting && <IconLoader2 size={14} className="animate-spin" />}
      {isConnecting ? "Connecting..." : `Authorize ${agentName}`}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

function useDirectedAuthorizeParams(): {
  readonly connectorType: ConnectorRef;
  readonly agentId: string;
} | null {
  const type = useGet(directedAuthorizeType$);
  const agentId = useGet(directedAuthorizeAgentId$);
  if (!type || !agentId) {
    return null;
  }
  const parsed = connectorRefSchema.safeParse(type);
  if (!parsed.success) {
    return null;
  }
  return { connectorType: parsed.data, agentId };
}

function useDirectedAuthorizeCatalogState(connectorType: ConnectorRef | null) {
  const justConnected = useGet(justConnectedTypes$);
  const allLoadable = useLastLoadable(allConnectorTypes$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data : [];
  const item = connectorType
    ? allData.find((connector) => {
        return connector.type === connectorType;
      })
    : undefined;
  const isConnected =
    connectorType !== null &&
    (justConnected.has(connectorType) || item?.connected === true);
  return {
    item,
    isConnected,
    catalogLoading:
      connectorType !== null &&
      !justConnected.has(connectorType) &&
      allLoadable.state === "loading",
    unavailable:
      connectorType !== null && catalogLoaded && !item && !isConnected,
  };
}

function useDirectedAuthorizePermissionState(
  connectorType: ConnectorRef | null,
  agentId: string | null,
) {
  const justAuthorizedKeys = useGet(justAuthorizedConnectorAgentKeys$);
  const enabledLoadable = useLastLoadable(agentEnabledTypes$);
  const enabledData =
    agentId !== null &&
    enabledLoadable.state === "hasData" &&
    enabledLoadable.data.agentId === agentId
      ? enabledLoadable.data
      : null;
  const enabledTypes = enabledData === null ? [] : enabledData.enabledTypes;
  return {
    isAuthorized:
      connectorType !== null &&
      agentId !== null &&
      (isJustAuthorizedConnectorAgent(justAuthorizedKeys, {
        connectorType,
        agentId,
      }) ||
        enabledTypes.includes(connectorType)),
    permissionLoading:
      agentId !== null &&
      (enabledLoadable.state === "loading" ||
        (enabledLoadable.state === "hasData" && enabledData === null)),
  };
}

function useDirectedAuthorizeAgentName(agentId: string | null): string {
  const agentNameLoadable = useLastLoadable(directedAuthorizeAgentName$);
  if (
    agentNameLoadable.state !== "hasData" ||
    agentNameLoadable.data.agentId !== agentId ||
    !agentNameLoadable.data.displayName
  ) {
    return "Zero";
  }
  return agentNameLoadable.data.displayName;
}

function canAuthorizeConnector(
  item:
    | { readonly availableAuthMethods: readonly ConnectorAuthMethodId[] }
    | undefined,
  isConnected: boolean,
): boolean {
  return isConnected || (item ? item.availableAuthMethods.length > 0 : false);
}

function directedAuthorizeConnectModalOpen(
  key: DirectedAuthorizeConnectModalKey | null,
  args: {
    readonly connectorType: ConnectorRef | null;
    readonly agentId: string | null;
    readonly signal: AbortSignal;
  },
): boolean {
  return (
    key?.connectorType === args.connectorType &&
    key.agentId === args.agentId &&
    key.signal === args.signal
  );
}

function DirectedAuthorizeCardContent({
  icon,
  connectorLabel,
  connectorDescription,
  agentName,
  isAuthorized,
  isConnecting,
  isLoading,
  canAuthorize,
  onAuthorize,
}: {
  readonly icon: ConnectorTypeWithStatus["icon"] | undefined;
  readonly connectorLabel: string;
  readonly connectorDescription: string;
  readonly agentName: string;
  readonly isAuthorized: boolean;
  readonly isConnecting: boolean;
  readonly isLoading: boolean;
  readonly canAuthorize: boolean;
  readonly onAuthorize: () => void;
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
                  {isAuthorized
                    ? `${connectorLabel} authorized`
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
            <div className="flex items-center justify-center">
              <AuthorizeAction
                isAuthorized={isAuthorized}
                isConnecting={isConnecting}
                disabled={!canAuthorize}
                agentName={agentName}
                onAuthorize={onAuthorize}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function runDirectedAuthorize(params: {
  readonly canAuthorize: boolean;
  readonly isConnected: boolean;
  readonly item: ConnectorTypeWithStatus | undefined;
  readonly connectorType: ConnectorRef;
  readonly connectorLabel: string;
  readonly agentId: string;
  readonly authMethod: ConnectorStatusAuthMethodDetail | null;
  readonly signal: AbortSignal;
  readonly authorize: (
    connectorType: ConnectorRef,
    agentId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly connect: (
    connectorType: ConnectorRef,
    method: ConnectorStatusAuthMethodDetail,
    options: {
      readonly connectorLabel?: string;
      readonly agentId?: string;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly connectNoAuth: (
    args: {
      readonly type: ConnectorRef;
      readonly authMethod: ConnectorAuthMethodId;
      readonly options: {
        readonly connectorLabel?: string;
        readonly agentId?: string;
      };
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly openConnectModal: () => void;
  readonly reloadAuthorization: () => void;
  readonly onSuccess: () => void | Promise<void>;
}): void {
  if (!params.canAuthorize) {
    return;
  }
  if (params.isConnected) {
    detach(
      (async () => {
        await params.authorize(
          params.connectorType,
          params.agentId,
          params.signal,
        );
        await params.onSuccess();
      })(),
      Reason.DomCallback,
    );
    return;
  }
  const launchMode = params.item
    ? getConnectorStatusConnectLaunchMode(params.item)
    : "modal";
  const browserAuthMethod =
    launchMode === "browser-auth" ? params.authMethod : null;
  const noAuthMethod =
    launchMode === "no-auth" && params.item
      ? getOnlyAvailableStatusNoAuthMethod(params.item)
      : null;
  if (browserAuthMethod || noAuthMethod) {
    detach(
      (async () => {
        let connected = false;
        if (browserAuthMethod) {
          connected = await params.connect(
            params.connectorType,
            browserAuthMethod,
            {
              connectorLabel: params.connectorLabel,
              agentId: params.agentId,
            },
            params.signal,
          );
        } else if (noAuthMethod) {
          connected = await params.connectNoAuth(
            {
              type: params.connectorType,
              authMethod: noAuthMethod,
              options: {
                connectorLabel: params.connectorLabel,
                agentId: params.agentId,
              },
            },
            params.signal,
          );
        } else {
          return;
        }
        if (connected) {
          params.reloadAuthorization();
          await params.onSuccess();
        }
      })(),
      Reason.DomCallback,
    );
    return;
  }
  if (params.item && params.item.availableAuthMethods.length > 0) {
    params.openConnectModal();
  }
}

function DirectedAuthorizeCard() {
  const params = useDirectedAuthorizeParams();
  const pollingType = useGet(pollingOAuthAuthCodeConnectorType$);
  const connectFlowType = useGet(connectFlowType$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const authorize = useSet(authorizeConnector$);
  const reloadAuthorization = useSet(reloadAgentConnectorAuthorizations$);
  const signal = useGet(pageSignal$);
  const connectModalKey = useGet(directedAuthorizeConnectModalKey$);
  const setDirectedAuthorizeConnectModalKey = useSet(
    setDirectedAuthorizeConnectModalKey$,
  );
  const actionCallback = useGet(routeChatActionCallback$);
  const runCallback = useSet(runChatActionCallback$);
  const connectorTypeForState = params?.connectorType ?? null;
  const agentName = useDirectedAuthorizeAgentName(params?.agentId ?? null);
  const { item, isConnected, catalogLoading, unavailable } =
    useDirectedAuthorizeCatalogState(connectorTypeForState);
  const { isAuthorized, permissionLoading } =
    useDirectedAuthorizePermissionState(
      connectorTypeForState,
      params?.agentId ?? null,
    );
  const connectModalOpen = directedAuthorizeConnectModalOpen(connectModalKey, {
    connectorType: connectorTypeForState,
    agentId: params?.agentId ?? null,
    signal,
  });

  if (!params) {
    return null;
  }

  const { connectorType, agentId } = params;
  const isConnecting =
    pollingType === connectorType || connectFlowType === connectorType;
  if (unavailable) {
    return null;
  }

  const isLoading = catalogLoading || permissionLoading;
  const canAuthorize = canAuthorizeConnector(item, isConnected);
  const selectedAuthMethod = item
    ? getOnlyAvailableStatusBrowserAuthMethodDetail(item)
    : null;
  const connectorLabel = item?.label ?? connectorType;
  const connectorDescription = item?.helpText ?? "";
  const handleAuthorizeSuccess = async () => {
    if (actionCallback.callbackPrompt && actionCallback.threadId) {
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

  const handleAuthorize = () => {
    runDirectedAuthorize({
      canAuthorize,
      isConnected,
      item,
      connectorType,
      connectorLabel,
      agentId,
      authMethod: selectedAuthMethod,
      signal,
      authorize,
      connect,
      connectNoAuth,
      reloadAuthorization,
      onSuccess: handleAuthorizeSuccess,
      openConnectModal: () => {
        setDirectedAuthorizeConnectModalKey({ connectorType, agentId, signal });
      },
    });
  };

  return (
    <>
      <DirectedAuthorizeCardContent
        icon={item?.icon}
        connectorLabel={connectorLabel}
        connectorDescription={connectorDescription}
        agentName={agentName}
        isAuthorized={isAuthorized}
        isConnecting={isConnecting}
        isLoading={isLoading}
        canAuthorize={canAuthorize}
        onAuthorize={handleAuthorize}
      />
      {connectModalOpen && (
        <ConnectModal
          selectedType={connectorType}
          agentId={agentId}
          onSuccess={async () => {
            reloadAuthorization();
            await handleAuthorizeSuccess();
          }}
          onClose={() => {
            setDirectedAuthorizeConnectModalKey(null);
          }}
        />
      )}
    </>
  );
}

export function ZeroDirectedAuthorizePage() {
  return <DirectedAuthorizeCard />;
}
