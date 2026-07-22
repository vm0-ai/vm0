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
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorCatalogItems$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowConnectorRef$,
  getConnectorStatusConnectLaunchMode,
  getOnlyAvailableStatusBrowserAuthMethodDetail,
  getOnlyAvailableStatusNoAuthMethod,
  justConnectedRefs$,
  pollingOAuthAuthCodeConnectorRef$,
} from "../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  directedAuthorizeRef$,
  directedAuthorizeAgentId$,
  directedAuthorizeAgentName$,
  agentEnabledTypes$,
  justAuthorizedConnectorAgentKeys$,
  authorizeConnector$,
  isJustAuthorizedConnectorAgent,
  directedAuthorizeConnectModalKey$,
  setDirectedAuthorizeConnectModalKey$,
  type DirectedAuthorizeConnectModalKey,
} from "../../signals/connectors-page/directed-authorize-ref.ts";
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
  readonly connectorRef: ConnectorRef;
  readonly agentId: string;
} | null {
  const routeType = useGet(directedAuthorizeRef$);
  const agentId = useGet(directedAuthorizeAgentId$);
  if (!routeType || !agentId) {
    return null;
  }
  const parsed = connectorRefSchema.safeParse(routeType);
  if (!parsed.success) {
    return null;
  }
  return { connectorRef: parsed.data, agentId };
}

function useDirectedAuthorizeCatalogState(connectorRef: ConnectorRef | null) {
  const justConnected = useGet(justConnectedRefs$);
  const allLoadable = useLastLoadable(allConnectorCatalogItems$);
  const catalogLoaded = allLoadable.state === "hasData";
  const allData = catalogLoaded ? allLoadable.data : [];
  const item = connectorRef
    ? allData.find((connector) => {
        return connector.connectorRef === connectorRef;
      })
    : undefined;
  const isConnected =
    connectorRef !== null &&
    (justConnected.has(connectorRef) || item?.connected === true);
  return {
    item,
    isConnected,
    catalogLoading:
      connectorRef !== null &&
      !justConnected.has(connectorRef) &&
      allLoadable.state === "loading",
    unavailable:
      connectorRef !== null && catalogLoaded && !item && !isConnected,
  };
}

function useDirectedAuthorizePermissionState(
  connectorRef: ConnectorRef | null,
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
      connectorRef !== null &&
      agentId !== null &&
      (isJustAuthorizedConnectorAgent(justAuthorizedKeys, {
        connectorRef,
        agentId,
      }) ||
        enabledTypes.includes(connectorRef)),
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
  item: Pick<PublicConnectorCatalogStatusItem, "authMethods"> | undefined,
  isConnected: boolean,
): boolean {
  return isConnected || (item ? item.authMethods.length > 0 : false);
}

function directedAuthorizeConnectModalOpen(
  key: DirectedAuthorizeConnectModalKey | null,
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
  readonly icon: PublicConnectorCatalogStatusItem["icon"] | undefined;
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
  readonly item: PublicConnectorCatalogStatusItem | undefined;
  readonly connectorRef: ConnectorRef;
  readonly connectorLabel: string;
  readonly agentId: string;
  readonly authMethod: PublicConnectorCatalogAuthMethodDetail | null;
  readonly signal: AbortSignal;
  readonly authorize: (
    connectorRef: ConnectorRef,
    agentId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly connect: (
    connectorRef: ConnectorRef,
    method: PublicConnectorCatalogAuthMethodDetail,
    options: {
      readonly connectorLabel?: string;
      readonly agentId?: string;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly connectNoAuth: (
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
          params.connectorRef,
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
            params.connectorRef,
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
              connectorRef: params.connectorRef,
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
  if (params.item && params.item.authMethods.length > 0) {
    params.openConnectModal();
  }
}

function DirectedAuthorizeCard() {
  const params = useDirectedAuthorizeParams();
  const pollingConnectorRef = useGet(pollingOAuthAuthCodeConnectorRef$);
  const connectFlowConnectorRef = useGet(connectFlowConnectorRef$);
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
  const connectorRefForState = params?.connectorRef ?? null;
  const agentName = useDirectedAuthorizeAgentName(params?.agentId ?? null);
  const { item, isConnected, catalogLoading, unavailable } =
    useDirectedAuthorizeCatalogState(connectorRefForState);
  const { isAuthorized, permissionLoading } =
    useDirectedAuthorizePermissionState(
      connectorRefForState,
      params?.agentId ?? null,
    );
  const connectModalOpen = directedAuthorizeConnectModalOpen(connectModalKey, {
    connectorRef: connectorRefForState,
    agentId: params?.agentId ?? null,
    signal,
  });

  if (!params) {
    return null;
  }

  const { connectorRef, agentId } = params;
  const isConnecting =
    pollingConnectorRef === connectorRef ||
    connectFlowConnectorRef === connectorRef;
  if (unavailable) {
    return null;
  }

  const isLoading = catalogLoading || permissionLoading;
  const canAuthorize = canAuthorizeConnector(item, isConnected);
  const selectedAuthMethod = item
    ? getOnlyAvailableStatusBrowserAuthMethodDetail(item)
    : null;
  const connectorLabel = item?.label ?? connectorRef;
  const connectorDescription = item?.description ?? "";
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
      connectorRef,
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
        setDirectedAuthorizeConnectModalKey({ connectorRef, agentId, signal });
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
          selectedConnectorRef={connectorRef}
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
