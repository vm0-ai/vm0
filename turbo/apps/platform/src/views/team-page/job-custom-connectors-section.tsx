import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { customConnectors$ } from "../../signals/zero-page/settings/custom-connectors.ts";
import {
  agentCustomConnectorToggleSaving$,
  agentCustomConnectorGrants$,
  agentCustomConnectorPermissionBundle$,
  agentAddedCustomConnectors$,
  closeCustomConnectorPermissions$,
  customConnectorPermissionTargetId$,
  openCustomConnectorPermissions$,
  toggleAgentCustomConnector$,
} from "../../signals/zero-page/job-detail/custom-connectors.ts";
import { agentDetail$ } from "../../signals/zero-page/job-detail/detail.ts";
import { customConnectorPermissionsEnabled$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { CustomConnectorIcon } from "../zero-page/components/settings/custom-connector-icon.tsx";
import { CustomConnectorPermissionsDrawer } from "./custom-connector-permissions-drawer.tsx";

function CustomConnectorPermissionRow({
  connector,
  enabled,
  loading,
  disabled,
  showManage,
  isLast,
  onToggle,
  onManage,
}: {
  connector: CustomConnectorResponse;
  enabled: boolean;
  loading: boolean;
  disabled: boolean;
  showManage: boolean;
  isLast: boolean;
  onToggle: (checked: boolean) => void;
  onManage: () => void;
}) {
  const { t } = useTranslation("agents");
  const { t: tCommon } = useTranslation();
  return (
    <div
      className={
        isLast
          ? "flex items-center gap-3 px-5 py-4"
          : "flex items-center gap-3 px-5 py-4 border-b border-border/50"
      }
    >
      <CustomConnectorIcon
        id={connector.id}
        displayName={connector.displayName}
        size={20}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {connector.displayName}
        </div>
        <div className="truncate text-xs text-muted-foreground font-mono">
          {connector.prefixes[0]}
          {!connector.hasSecret &&
            t(($) => {
              return $.authorization.customConnectors.noSecretSuffix;
            })}
        </div>
      </div>
      {showManage ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onManage}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={tCommon(
                  ($) => {
                    return $.connectors.card.managePermissionsFor;
                  },
                  { connector: connector.displayName },
                )}
              >
                <IconAdjustmentsHorizontal size={15} stroke={1.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">
                {tCommon(($) => {
                  return $.connectors.card.managePermissions;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      <LoadingSwitch
        checked={enabled}
        loading={loading}
        disabled={disabled}
        onCheckedChange={onToggle}
        ariaLabel={t(
          ($) => {
            return $.authorization.customConnectors.authorize;
          },
          { connectorName: connector.displayName },
        )}
      />
      {!connector.hasSecret && (
        <span className="sr-only">
          {t(($) => {
            return $.authorization.customConnectors.noSecret;
          })}
        </span>
      )}
    </div>
  );
}

export function JobCustomConnectorsSection() {
  const { t } = useTranslation("agents");
  const connectors = useLastResolved(customConnectors$);
  const addedLoadable = useLastLoadable(agentAddedCustomConnectors$);
  const added = addedLoadable.state === "hasData" ? addedLoadable.data : [];
  const addedSet = new Set(added);
  const [, toggle] = useLoadableSet(toggleAgentCustomConnector$);
  const pageSignal = useGet(pageSignal$);
  const saving = useGet(agentCustomConnectorToggleSaving$);
  const permissionEditingEnabled = useGet(customConnectorPermissionsEnabled$);
  const permissionTargetId = useGet(customConnectorPermissionTargetId$);
  const openPermissions = useSet(openCustomConnectorPermissions$);
  const closePermissions = useSet(closeCustomConnectorPermissions$);
  const permissionBundleLoadable = useLoadable(
    agentCustomConnectorPermissionBundle$,
  );
  const grantsLoadable = useLastLoadable(agentCustomConnectorGrants$);
  const detail = useLastResolved(agentDetail$);

  if (!connectors || connectors.length === 0) {
    return null;
  }

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

  const permissionTarget = permissionTargetId
    ? connectors.find((connector) => {
        return connector.id === permissionTargetId;
      })
    : undefined;
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
      {connectors.map((c, i) => {
        const enabled = addedSet.has(c.id);
        return (
          <CustomConnectorPermissionRow
            key={c.id}
            connector={c}
            enabled={enabled}
            loading={saving}
            disabled={!c.hasSecret && !enabled}
            showManage={
              permissionEditingEnabled &&
              c.hasSecret &&
              c.permissionBundleRef !== null &&
              c.permissionBundleRef !== undefined &&
              grantsLoadable.state === "hasData"
            }
            isLast={i === connectors.length - 1}
            onToggle={(checked) => {
              return handleToggle(c.id, checked);
            }}
            onManage={() => {
              openPermissions({
                connectorId: c.id,
                permissionNames:
                  grantsLoadable.state === "hasData"
                    ? (grantsLoadable.data.find((grant) => {
                        return grant.customConnectorId === c.id;
                      })?.permissionNames ?? [])
                    : [],
              });
            }}
          />
        );
      })}
      {permissionTarget ? (
        <CustomConnectorPermissionsDrawer
          connectorId={permissionTarget.id}
          connectorName={permissionTarget.displayName}
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
            closePermissions();
          }}
        />
      ) : null}
    </div>
  );
}
