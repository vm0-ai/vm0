import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  connectorTypeSchema,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorTypes$,
  connectConnectorOAuthAuthCode$,
  getOnlyAvailableStatusAuthCodeAuthMethod,
  justConnectedTypes$,
  pollingOAuthAuthCodeConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
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
} from "../../signals/connectors-page/directed-authorize-type.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import {
  Vm0LogoLink,
  GoogleSecurityWarningNotice,
} from "./zero-directed-shared.tsx";
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
  readonly connectorType: ConnectorType;
  readonly agentId: string;
} | null {
  const type = useGet(directedAuthorizeType$);
  const agentId = useGet(directedAuthorizeAgentId$);
  if (!type || !agentId) {
    return null;
  }
  const parsed = connectorTypeSchema.safeParse(type);
  if (!parsed.success) {
    return null;
  }
  return { connectorType: parsed.data, agentId };
}

function useDirectedAuthorizeCatalogState(connectorType: ConnectorType | null) {
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
  connectorType: ConnectorType | null,
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
      (enabledLoadable.state === "loading" || enabledData === null),
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

function shouldShowDirectedAuthorizeGoogleSecurityWarning(args: {
  readonly isAuthorized: boolean;
  readonly isConnected: boolean;
  readonly item: ConnectorTypeWithStatus | undefined;
}): boolean {
  return (
    !args.isAuthorized &&
    !args.isConnected &&
    args.item?.connectNotice === "google-security-warning"
  );
}

function runDirectedAuthorize(params: {
  readonly canAuthorize: boolean;
  readonly isConnected: boolean;
  readonly item: ConnectorTypeWithStatus | undefined;
  readonly connectorType: ConnectorType;
  readonly connectorLabel: string;
  readonly agentId: string;
  readonly authMethod: ConnectorAuthMethodId | null;
  readonly signal: AbortSignal;
  readonly authorize: (
    connectorType: ConnectorType,
    agentId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly connect: (
    connectorType: ConnectorType,
    authMethod: ConnectorAuthMethodId,
    options: { readonly connectorLabel?: string },
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly openConnectModal: () => void;
}): void {
  if (!params.canAuthorize) {
    return;
  }
  if (params.isConnected) {
    detach(
      params.authorize(params.connectorType, params.agentId, params.signal),
      Reason.DomCallback,
    );
    return;
  }
  const authMethod = params.authMethod;
  if (authMethod) {
    detach(
      (async () => {
        const connected = await params.connect(
          params.connectorType,
          authMethod,
          { connectorLabel: params.connectorLabel },
          params.signal,
        );
        if (!connected) {
          return;
        }
        await params.authorize(
          params.connectorType,
          params.agentId,
          params.signal,
        );
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
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const authorize = useSet(authorizeConnector$);
  const signal = useGet(pageSignal$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelectedConnectorType = useSet(setSelectedConnectorType$);
  const connectorTypeForState = params?.connectorType ?? null;
  const agentName = useDirectedAuthorizeAgentName(params?.agentId ?? null);
  const { item, isConnected, catalogLoading, unavailable } =
    useDirectedAuthorizeCatalogState(connectorTypeForState);
  const { isAuthorized, permissionLoading } =
    useDirectedAuthorizePermissionState(
      connectorTypeForState,
      params?.agentId ?? null,
    );

  if (!params) {
    return null;
  }

  const { connectorType, agentId } = params;
  const isConnecting = pollingType === connectorType;
  if (unavailable) {
    return null;
  }

  const isLoading = catalogLoading || permissionLoading;
  const canAuthorize = canAuthorizeConnector(item, isConnected);
  const selectedAuthMethod = item
    ? getOnlyAvailableStatusAuthCodeAuthMethod(item)
    : null;
  const showGoogleSecurityWarningNotice =
    shouldShowDirectedAuthorizeGoogleSecurityWarning({
      isAuthorized,
      isConnected,
      item,
    });
  const connectorLabel = item?.label ?? connectorType;
  const connectorDescription = item?.helpText ?? "";

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
                    {isAuthorized
                      ? `${connectorLabel} authorized`
                      : `${agentName} needs ${connectorLabel} to proceed`}
                  </h1>
                  <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
                    <ConnectorIcon type={connectorType} size={20} />
                  </div>
                  <p className="w-60 text-sm text-muted-foreground">
                    {connectorDescription}
                  </p>
                  {showGoogleSecurityWarningNotice && (
                    <GoogleSecurityWarningNotice />
                  )}
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
                  onAuthorize={handleAuthorize}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {selectedConnectorType === connectorType && (
        <ConnectModal
          onClose={() => {
            setSelectedConnectorType(null);
          }}
          onSuccess={async () => {
            await authorize(connectorType, agentId, signal);
          }}
        />
      )}
    </>
  );
}

export function ZeroDirectedAuthorizePage() {
  return <DirectedAuthorizeCard />;
}
