import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectFlowConnectorSlug$,
  justConnectedSlugs$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  selectedConnectorSlug$,
  setSelectedConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "../okou-page/components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "../okou-page/components/settings/connector-card.tsx";
import type { ConnectorConnectHandlers } from "../okou-page/components/settings/launch-connector-connect.ts";
import {
  connectorAccountOptionsFor,
  defaultBuiltinConnectorAccountMode,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";

type ConnectorSetupVariant = "workflow" | "prompt";

function parseConnectorSlugs(values: readonly string[]): ConnectorSlug[] {
  return values.flatMap((value) => {
    const parsed = connectorSlugSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function OnboardingConnectorCard({
  connectorSlug,
  item,
  connected,
  connecting,
  loading,
  layout,
  required,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly item: PlatformConnectorCatalogStatusItem | undefined;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly loading: boolean;
  readonly layout: ConnectorSetupVariant;
  readonly required: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const setSelectedConnectorSlug = useSet(setSelectedConnectorSlug$);
  const accountMode = defaultBuiltinConnectorAccountMode(item);
  const connectHandlers: ConnectorConnectHandlers | undefined =
    item && accountMode
      ? {
          openModal: () => {
            setSelectedConnectorSlug(connectorSlug);
          },
          connectBrowserAuth: (authMethod) => {
            return connect(
              connectorSlug,
              authMethod,
              {
                connectorLabel: item.label,
                connectorIcon: item.icon,
                authorizeVisibleAgents: true,
                ...connectorAccountOptionsFor(accountMode),
              },
              pageSignal,
            );
          },
          connectNoAuth: (authMethod) => {
            return connectNoAuth(
              {
                connectorSlug,
                authMethod,
                options: {
                  connectorLabel: item.label,
                  authorizeVisibleAgents: true,
                  ...connectorAccountOptionsFor(accountMode),
                },
              },
              pageSignal,
            );
          },
        }
      : undefined;

  return (
    <ConnectorCard
      variant="onboarding"
      connectorSlug={connectorSlug}
      connector={item}
      connected={connected}
      busy={connecting}
      loading={loading}
      layout={layout}
      required={required}
      connect={connectHandlers}
    />
  );
}

export function OnboardingConnectorSetup({
  connectorSlugs,
  requiredConnectorSlugs,
  variant = "workflow",
  children,
}: {
  readonly connectorSlugs: readonly string[];
  readonly requiredConnectorSlugs?: readonly string[];
  readonly variant?: ConnectorSetupVariant;
  readonly children?: ReactNode;
}) {
  const validConnectorSlugs = parseConnectorSlugs(connectorSlugs);
  const requiredSet = new Set(
    parseConnectorSlugs(requiredConnectorSlugs ?? []),
  );
  const connectorCatalogItemsLoadable = useLastLoadable(
    connectorCatalogStatus$,
  );
  const selectedConnectorSlug = useGet(selectedConnectorSlug$);
  const setSelectedConnectorSlug = useSet(setSelectedConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const justConnectedSlugs = useGet(justConnectedSlugs$);

  if (validConnectorSlugs.length === 0 && children === undefined) {
    return null;
  }

  const connectorCatalogItems =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data.connectors
      : [];
  const selectedConnector = selectedConnectorSlug
    ? connectorCatalogItems.find((connector) => {
        return connector.slug === selectedConnectorSlug;
      })
    : undefined;
  const selectedAccountMode =
    defaultBuiltinConnectorAccountMode(selectedConnector);
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
        {validConnectorSlugs.map((connectorSlug) => {
          const item = connectorCatalogItems.find((candidate) => {
            return candidate.slug === connectorSlug;
          });
          const connected =
            item?.connected === true || justConnectedSlugs.has(connectorSlug);
          const connecting =
            connectFlowSlug === connectorSlug ||
            pollingAuthCodeSlug === connectorSlug ||
            pollingDeviceAuthSlug === connectorSlug;

          return (
            <OnboardingConnectorCard
              key={connectorSlug}
              connectorSlug={connectorSlug}
              item={item}
              connected={connected}
              connecting={connecting}
              loading={loading}
              layout={variant}
              required={requiredSet.has(connectorSlug)}
            />
          );
        })}
        {children}
      </section>
      {selectedConnector && selectedAccountMode ? (
        <ConnectModal
          item={selectedConnector}
          accountMode={selectedAccountMode}
          authorizeVisibleAgentsOnConnect
          onClose={() => {
            setSelectedConnectorSlug(null);
          }}
        />
      ) : null}
    </>
  );
}
