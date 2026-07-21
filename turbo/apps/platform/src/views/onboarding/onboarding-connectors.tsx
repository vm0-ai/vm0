import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { IconLoader2, IconPlugConnected } from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  connectorCatalogRefSchema,
  type ConnectorCatalogRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  allConnectorTypes$,
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectFlowType$,
  justConnectedTypes$,
  pollingOAuthAuthCodeConnectorType$,
  pollingOAuthDeviceAuthConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { ConnectModal } from "../zero-page/components/settings/add-connection-dialog.tsx";
import { launchConnectorConnect } from "../zero-page/components/settings/launch-connector-connect.ts";

function connectorRefs(values: readonly string[]): ConnectorCatalogRef[] {
  return values.flatMap((value) => {
    const parsed = connectorCatalogRefSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function OnboardingConnectorRow({
  connectorRef,
  item,
  connected,
  connecting,
  loading,
  onConnect,
}: {
  readonly connectorRef: ConnectorCatalogRef;
  readonly item: ConnectorTypeWithStatus | undefined;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly loading: boolean;
  readonly onConnect: (item: ConnectorTypeWithStatus) => void;
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-3 py-2.5 sm:px-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--gray-100))]">
        <ConnectorIcon icon={item?.icon} size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {item?.label ?? connectorRef}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {connected
            ? "Connected to your account"
            : (item?.helpText ?? "Connection required")}
        </p>
      </div>
      {connected ? (
        <span className="inline-flex h-8 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Connected
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !item || connecting}
          onClick={() => {
            if (item) {
              onConnect(item);
            }
          }}
        >
          {connecting ? (
            <IconLoader2 className="animate-spin" aria-hidden="true" />
          ) : null}
          Connect
        </Button>
      )}
    </div>
  );
}

export function OnboardingConnectorSetup({
  connectorIds,
}: {
  readonly connectorIds: readonly string[];
}) {
  const refs = connectorRefs(connectorIds);
  const pageSignal = useGet(pageSignal$);
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const connectType = useGet(selectedConnectorType$);
  const setConnectType = useSet(setSelectedConnectorType$);
  const connectFlowType = useGet(connectFlowType$);
  const pollingAuthCodeType = useGet(pollingOAuthAuthCodeConnectorType$);
  const pollingDeviceAuthType = useGet(pollingOAuthDeviceAuthConnectorType$);
  const justConnectedTypes = useGet(justConnectedTypes$);

  if (refs.length === 0) {
    return null;
  }

  const connectorTypes =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const loading = connectorTypesLoadable.state === "loading";

  return (
    <section className="mt-7 border-t border-border pt-6">
      <div className="mb-4 flex items-center gap-2">
        <IconPlugConnected
          size={18}
          stroke={1.6}
          className="text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-sm font-medium">Connect the tools for this run</h2>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {refs.map((connectorRef) => {
          const item = connectorTypes.find((candidate) => {
            return candidate.type === connectorRef;
          });
          const connected =
            item?.connected === true || justConnectedTypes.has(connectorRef);
          const connecting =
            connectFlowType === connectorRef ||
            pollingAuthCodeType === connectorRef ||
            pollingDeviceAuthType === connectorRef;

          return (
            <OnboardingConnectorRow
              key={connectorRef}
              connectorRef={connectorRef}
              item={item}
              connected={connected}
              connecting={connecting}
              loading={loading}
              onConnect={(connector) => {
                launchConnectorConnect({
                  connector,
                  openModal: () => {
                    setConnectType(connectorRef);
                  },
                  connectBrowserAuth: (authMethod) => {
                    return connect(
                      connectorRef,
                      authMethod,
                      { connectorLabel: connector.label },
                      pageSignal,
                    );
                  },
                  connectNoAuth: (authMethod) => {
                    return connectNoAuth(
                      {
                        type: connectorRef,
                        authMethod,
                        options: { connectorLabel: connector.label },
                      },
                      pageSignal,
                    );
                  },
                });
              }}
            />
          );
        })}
      </div>
      {connectType ? (
        <ConnectModal
          onClose={() => {
            setConnectType(null);
          }}
        />
      ) : null}
    </section>
  );
}
