import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  allConnectorCatalogItems$,
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectFlowConnectorSlug$,
  justConnectedSlugs$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  selectedConnectorSlug$,
  setSelectedConnectorSlug$,
} from "../../signals/zero-page/settings/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "../zero-page/components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "../zero-page/components/settings/connector-card.tsx";

type ConnectorSetupVariant = "workflow" | "prompt";

function parseConnectorSlugs(values: readonly string[]): ConnectorSlug[] {
  return values.flatMap((value) => {
    const parsed = connectorSlugSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function OnboardingConnectorSetup({
  connectorIds,
  requiredIds,
  variant = "workflow",
  children,
}: {
  readonly connectorIds: readonly string[];
  readonly requiredIds?: readonly string[];
  readonly variant?: ConnectorSetupVariant;
  readonly children?: ReactNode;
}) {
  const connectorSlugs = parseConnectorSlugs(connectorIds);
  const requiredSet = new Set(parseConnectorSlugs(requiredIds ?? []));
  const pageSignal = useGet(pageSignal$);
  const connectorCatalogItemsLoadable = useLastLoadable(
    allConnectorCatalogItems$,
  );
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const selectedConnectorSlug = useGet(selectedConnectorSlug$);
  const setSelectedConnectorSlug = useSet(setSelectedConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const justConnectedSlugs = useGet(justConnectedSlugs$);

  if (connectorSlugs.length === 0 && children === undefined) {
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
        {connectorSlugs.map((connectorSlug) => {
          const item = connectorCatalogItems.find((candidate) => {
            return candidate.connectorRef === connectorSlug;
          });
          const connected =
            item?.connected === true || justConnectedSlugs.has(connectorSlug);
          const connecting =
            connectFlowSlug === connectorSlug ||
            pollingAuthCodeSlug === connectorSlug ||
            pollingDeviceAuthSlug === connectorSlug;

          return (
            <ConnectorCard
              key={connectorSlug}
              variant="onboarding"
              connectorSlug={connectorSlug}
              connector={item}
              connected={connected}
              busy={connecting}
              loading={loading}
              layout={variant}
              required={requiredSet.has(connectorSlug)}
              connect={
                item
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
                          },
                          pageSignal,
                        );
                      },
                      connectNoAuth: (authMethod) => {
                        return connectNoAuth(
                          {
                            connectorSlug,
                            authMethod,
                            options: { connectorLabel: item.label },
                          },
                          pageSignal,
                        );
                      },
                    }
                  : undefined
              }
            />
          );
        })}
        {children}
      </section>
      {selectedConnectorSlug ? (
        <ConnectModal
          onClose={() => {
            setSelectedConnectorSlug(null);
          }}
        />
      ) : null}
    </>
  );
}
