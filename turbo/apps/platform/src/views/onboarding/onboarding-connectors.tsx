import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { IconCircleCheck, IconLoader2 } from "@tabler/icons-react";
import { Button, cn } from "@vm0/ui";
import {
  connectorRefSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  allConnectorCatalogItems$,
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectFlowConnectorRef$,
  justConnectedRefs$,
  pollingOAuthAuthCodeConnectorRef$,
  pollingOAuthDeviceAuthConnectorRef$,
  selectedConnectorRef$,
  setSelectedConnectorRef$,
} from "../../signals/zero-page/settings/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { ConnectModal } from "../zero-page/components/settings/add-connection-dialog.tsx";
import { launchConnectorConnect } from "../zero-page/components/settings/launch-connector-connect.ts";

type ConnectorSetupVariant = "workflow" | "prompt";

function connectorRefs(values: readonly string[]): ConnectorRef[] {
  return values.flatMap((value) => {
    const parsed = connectorRefSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function useRequiredConnectorsGate(
  required: readonly string[] | undefined,
): {
  readonly blocked: boolean;
  readonly missingLabels: readonly string[];
} {
  const refs = connectorRefs(required ?? []);
  const connectorCatalogItemsLoadable = useLastLoadable(
    allConnectorCatalogItems$,
  );
  const justConnectedRefs = useGet(justConnectedRefs$);
  const items =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data
      : [];
  const missing = refs.filter((connectorRef) => {
    const item = items.find((candidate) => {
      return candidate.connectorRef === connectorRef;
    });
    return !(item?.connected === true || justConnectedRefs.has(connectorRef));
  });
  return {
    blocked: missing.length > 0,
    missingLabels: missing.map((connectorRef) => {
      const item = items.find((candidate) => {
        return candidate.connectorRef === connectorRef;
      });
      return item?.label ?? connectorRef;
    }),
  };
}

function promptHelpText(helpText: string | undefined): string {
  return (helpText ?? "Connect this account to continue")
    .replace(/^Connect your \w+ account to /u, "")
    .replace(/^Connect your Google account to /u, "")
    .replace(/^Connect /u, "");
}

function OnboardingConnectorRow({
  connectorRef,
  item,
  connected,
  connecting,
  loading,
  variant,
  onConnect,
}: {
  readonly connectorRef: ConnectorRef;
  readonly item: PublicConnectorCatalogStatusItem | undefined;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly loading: boolean;
  readonly variant: ConnectorSetupVariant;
  readonly onConnect: (item: PublicConnectorCatalogStatusItem) => void;
}) {
  const label = item?.label ?? connectorRef;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3",
        variant === "workflow"
          ? "border-b border-border/40 py-[18px] last:border-b-0"
          : "rounded-xl border border-border px-4 py-3.5 sm:px-5 sm:py-4",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
        <ConnectorIcon icon={item?.icon} size={22} />
      </span>
      <div className="min-w-0 flex-1">
        {variant === "workflow" ? (
          <p className="truncate text-sm leading-5 text-muted-foreground">
            Connect the {label} to continue the workflow
          </p>
        ) : (
          <>
            <p className="truncate text-sm font-medium">{label}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {promptHelpText(item?.description)}
            </p>
          </>
        )}
      </div>
      {connected ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary">
          <IconCircleCheck size={16} aria-hidden="true" />
          Connected
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-[10px] px-4 text-sm"
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
  variant = "workflow",
  children,
}: {
  readonly connectorIds: readonly string[];
  readonly variant?: ConnectorSetupVariant;
  readonly children?: ReactNode;
}) {
  const refs = connectorRefs(connectorIds);
  const pageSignal = useGet(pageSignal$);
  const connectorCatalogItemsLoadable = useLastLoadable(
    allConnectorCatalogItems$,
  );
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const connectRef = useGet(selectedConnectorRef$);
  const setConnectRef = useSet(setSelectedConnectorRef$);
  const connectFlowRef = useGet(connectFlowConnectorRef$);
  const pollingAuthCodeRef = useGet(pollingOAuthAuthCodeConnectorRef$);
  const pollingDeviceAuthRef = useGet(pollingOAuthDeviceAuthConnectorRef$);
  const justConnectedRefs = useGet(justConnectedRefs$);

  if (refs.length === 0 && children === undefined) {
    return null;
  }

  const connectorCatalogItems =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data
      : [];
  const loading = connectorCatalogItemsLoadable.state === "loading";

  return (
    <>
      <section
        className={cn(
          variant === "workflow"
            ? "mt-5 rounded-3xl border border-border bg-background px-6 pb-6"
            : "mt-6 flex flex-col gap-3",
        )}
      >
        {refs.map((connectorRef) => {
          const item = connectorCatalogItems.find((candidate) => {
            return candidate.connectorRef === connectorRef;
          });
          const connected =
            item?.connected === true || justConnectedRefs.has(connectorRef);
          const connecting =
            connectFlowRef === connectorRef ||
            pollingAuthCodeRef === connectorRef ||
            pollingDeviceAuthRef === connectorRef;

          return (
            <OnboardingConnectorRow
              key={connectorRef}
              connectorRef={connectorRef}
              item={item}
              connected={connected}
              connecting={connecting}
              loading={loading}
              variant={variant}
              onConnect={(connector) => {
                launchConnectorConnect({
                  connector,
                  openModal: () => {
                    setConnectRef(connectorRef);
                  },
                  connectBrowserAuth: (authMethod) => {
                    return connect(
                      connectorRef,
                      authMethod,
                      {
                        connectorLabel: connector.label,
                        connectorIcon: connector.icon,
                      },
                      pageSignal,
                    );
                  },
                  connectNoAuth: (authMethod) => {
                    return connectNoAuth(
                      {
                        connectorRef,
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
        {children}
      </section>
      {connectRef ? (
        <ConnectModal
          onClose={() => {
            setConnectRef(null);
          }}
        />
      ) : null}
    </>
  );
}
