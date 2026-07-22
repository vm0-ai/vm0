import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { IconCircleCheck, IconLoader2 } from "@tabler/icons-react";
import { Button, cn } from "@vm0/ui";
import {
  getStaticConnectorIconMetadata,
  isStaticConnectorIconType,
} from "@vm0/connectors/static-connector-icons";
import {
  connectorRefSchema,
  type ConnectorRef,
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

type ConnectorSetupVariant = "workflow" | "prompt";

function connectorRefs(values: readonly string[]): ConnectorRef[] {
  return values.flatMap((value) => {
    const parsed = connectorRefSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function OnboardingConnectorIcon({
  connectorId,
  size = 22,
}: {
  readonly connectorId: string;
  readonly size?: number;
}) {
  const icon = isStaticConnectorIconType(connectorId)
    ? getStaticConnectorIconMetadata(connectorId)
    : undefined;
  return <ConnectorIcon icon={icon} size={size} />;
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
  readonly item: ConnectorTypeWithStatus | undefined;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly loading: boolean;
  readonly variant: ConnectorSetupVariant;
  readonly onConnect: (item: ConnectorTypeWithStatus) => void;
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
        <OnboardingConnectorIcon connectorId={connectorRef} />
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
              {promptHelpText(item?.helpText)}
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
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const connectType = useGet(selectedConnectorType$);
  const setConnectType = useSet(setSelectedConnectorType$);
  const connectFlowType = useGet(connectFlowType$);
  const pollingAuthCodeType = useGet(pollingOAuthAuthCodeConnectorType$);
  const pollingDeviceAuthType = useGet(pollingOAuthDeviceAuthConnectorType$);
  const justConnectedTypes = useGet(justConnectedTypes$);

  if (refs.length === 0 && children === undefined) {
    return null;
  }

  const connectorTypes =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const loading = connectorTypesLoadable.state === "loading";

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
              variant={variant}
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
        {children}
      </section>
      {connectType ? (
        <ConnectModal
          onClose={() => {
            setConnectType(null);
          }}
        />
      ) : null}
    </>
  );
}
