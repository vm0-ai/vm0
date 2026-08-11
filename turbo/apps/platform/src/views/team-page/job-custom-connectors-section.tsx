import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  isHttpCustomConnectorResponse,
  type CustomConnectorHttpResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { AgentCustomConnectorGrant } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { customConnectors$ } from "../../signals/zero-page/settings/custom-connectors.ts";
import {
  agentCustomConnectorToggleSaving$,
  agentCustomConnectorGrants$,
  agentAddedCustomConnectors$,
  toggleAgentCustomConnector$,
} from "../../signals/zero-page/job-detail/custom-connectors.ts";
import {
  closeCustomConnectorPermissions$,
  customConnectorPermissionBundle$,
  customConnectorPermissionDraft$,
  openCustomConnectorPermissions$,
} from "../../signals/zero-page/settings/custom-connector-permissions.ts";
import { agentDetail$ } from "../../signals/zero-page/job-detail/detail.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { CustomConnectorIcon } from "../zero-page/components/settings/custom-connector-icon.tsx";
import { ConnectorPermissionRow } from "../zero-page/components/settings/connector-permission-row.tsx";
import { CustomConnectorPermissionsDrawer } from "../zero-page/components/settings/custom-connector-permissions-drawer.tsx";

function JobCustomConnectorRow({
  connector,
  enabled,
  loading,
  agentId,
  grants,
  grantsLoading,
  isLast,
  onToggle,
}: {
  readonly connector: CustomConnectorHttpResponse;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly agentId: string | undefined;
  readonly grants: readonly AgentCustomConnectorGrant[] | null;
  readonly grantsLoading: boolean;
  readonly isLast: boolean;
  readonly onToggle: (id: string, checked: boolean) => void;
}) {
  const openPermissions = useSet(openCustomConnectorPermissions$);
  const permissionNames =
    grants?.find((grant) => {
      return grant.customConnectorId === connector.id;
    })?.permissionNames ?? [];

  const openPermissionDrawer = (initiallyAuthorized: boolean) => {
    if (!agentId) {
      return;
    }
    openPermissions({
      surface: "agent-detail",
      agentId,
      connectorId: connector.id,
      initiallyAuthorized,
      permissionNames,
    });
  };

  return (
    <ConnectorPermissionRow
      icon={
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={20}
        />
      }
      label={connector.displayName}
      description={<span className="font-mono">{connector.prefixes[0]}</span>}
      enabled={enabled}
      loading={
        loading || (Boolean(connector.permissionBundleRef) && grantsLoading)
      }
      disabled={Boolean(connector.permissionBundleRef) && grants === null}
      showManage={
        enabled &&
        Boolean(connector.permissionBundleRef) &&
        grants !== null &&
        agentId !== undefined
      }
      isLast={isLast}
      onToggle={(checked) => {
        if (checked && connector.permissionBundleRef) {
          if (grants !== null && agentId) {
            openPermissionDrawer(false);
          }
          return;
        }
        onToggle(connector.id, checked);
      }}
      onManage={() => {
        openPermissionDrawer(enabled);
      }}
    />
  );
}

export function JobCustomConnectorsSection() {
  const connectors = useLastResolved(customConnectors$);
  const connectedHttpConnectors = connectors
    ?.filter(isHttpCustomConnectorResponse)
    .filter((connector) => {
      return connector.connected;
    });

  if (!connectedHttpConnectors || connectedHttpConnectors.length === 0) {
    return null;
  }

  return (
    <ConnectedJobCustomConnectorsSection connectors={connectedHttpConnectors} />
  );
}

function ConnectedJobCustomConnectorsSection({
  connectors,
}: {
  readonly connectors: readonly CustomConnectorHttpResponse[];
}) {
  const { t } = useTranslation("agents");
  const addedLoadable = useLastLoadable(agentAddedCustomConnectors$);
  const added = addedLoadable.state === "hasData" ? addedLoadable.data : [];
  const addedSet = new Set(added);
  const [, toggle] = useLoadableSet(toggleAgentCustomConnector$);
  const pageSignal = useGet(pageSignal$);
  const saving = useGet(agentCustomConnectorToggleSaving$);
  const permissionDraft = useGet(customConnectorPermissionDraft$);
  const closePermissions = useSet(closeCustomConnectorPermissions$);
  const permissionBundleLoadable = useLoadable(
    customConnectorPermissionBundle$,
  );
  const grantsLoadable = useLastLoadable(agentCustomConnectorGrants$);
  const detail = useLastResolved(agentDetail$);

  const handleToggle = (id: string, checked: boolean) => {
    if (saving) {
      return;
    }
    detach(
      (async () => {
        const saved = await toggle(id, checked, pageSignal);
        if (saved) {
          toast.success(
            t(($) => {
              return $.authorization.customConnectors.saved;
            }),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };

  const activePermissionDraft =
    permissionDraft?.surface === "agent-detail" &&
    permissionDraft.agentId === detail?.agentId
      ? permissionDraft
      : null;
  const permissionTargetConnector = activePermissionDraft
    ? connectors.find((connector) => {
        return connector.id === activePermissionDraft.connectorId;
      })
    : undefined;
  const permissionTarget =
    activePermissionDraft && permissionTargetConnector
      ? {
          connector: permissionTargetConnector,
          draft: activePermissionDraft,
        }
      : null;
  const permissionBundle =
    permissionBundleLoadable.state === "hasData"
      ? permissionBundleLoadable.data
      : null;

  return (
    <div className="zero-card">
      <div className="px-5 pt-4 pb-3 text-sm text-muted-foreground border-b border-border/50">
        {t(($) => {
          return $.authorization.customConnectors.description;
        })}
      </div>
      {connectors.map((connector, index) => {
        return (
          <JobCustomConnectorRow
            key={connector.id}
            connector={connector}
            enabled={addedSet.has(connector.id)}
            loading={saving}
            agentId={detail?.agentId}
            grants={
              grantsLoadable.state === "hasData" ? grantsLoadable.data : null
            }
            grantsLoading={grantsLoadable.state === "loading"}
            isLast={index === connectors.length - 1}
            onToggle={handleToggle}
          />
        );
      })}
      {permissionTarget ? (
        <CustomConnectorPermissionsDrawer
          agentId={permissionTarget.draft.agentId}
          connectorId={permissionTarget.connector.id}
          connectorName={permissionTarget.connector.displayName}
          agentName={
            detail?.displayName ??
            t(($) => {
              return $.fallbackName;
            })
          }
          bundle={permissionBundle}
          loading={permissionBundleLoadable.state === "loading"}
          loadError={permissionBundleLoadable.state === "hasError"}
          onClose={() => {
            closePermissions({
              surface: "agent-detail",
              agentId: permissionTarget.draft.agentId,
              connectorId: permissionTarget.draft.connectorId,
            });
          }}
        />
      ) : null}
    </div>
  );
}
