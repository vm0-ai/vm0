import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  connectorRefSchema,
  type ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
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
import { ConnectModal } from "../zero-page/components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "../zero-page/components/settings/connector-card.tsx";

type ConnectorSetupVariant = "workflow" | "prompt";

function connectorRefs(values: readonly string[]): ConnectorRef[] {
  return values.flatMap((value) => {
    const parsed = connectorRefSchema.safeParse(value);
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
  const refs = connectorRefs(connectorIds);
  const requiredSet = new Set(connectorRefs(requiredIds ?? []));
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
            <ConnectorCard
              key={connectorRef}
              variant="onboarding"
              connectorRef={connectorRef}
              connector={item}
              connected={connected}
              busy={connecting}
              loading={loading}
              layout={variant}
              required={requiredSet.has(connectorRef)}
              connect={
                item
                  ? {
                      openModal: () => {
                        setConnectRef(connectorRef);
                      },
                      connectBrowserAuth: (authMethod) => {
                        return connect(
                          connectorRef,
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
                            connectorRef,
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
