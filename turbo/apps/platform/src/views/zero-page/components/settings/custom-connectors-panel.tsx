import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  clearCustomConnectorSecret$,
  closeCustomConnectorDialog$,
  connectCustomConnectorOAuth2$,
  customConnectorAuthorizedAgentsById$,
  customConnectorDialog$,
  customConnectors$,
  openCustomConnectorAccessDialog$,
  openCustomConnectorConnectDialog$,
  openCustomConnectorDeleteDialog$,
  openCustomConnectorEditDialog$,
  openCustomConnectorRenameDialog$,
  setCustomConnectorRenameInput$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { CustomConnectorCreateDialog } from "./custom-connector-create-dialog.tsx";
import { CustomConnectorRenameDialog } from "./custom-connector-rename-dialog.tsx";
import { CustomConnectorConnectDialog } from "./custom-connector-connect-dialog.tsx";
import { CustomConnectorDeleteConfirm } from "./custom-connector-delete-confirm.tsx";
import { CustomConnectorAccessManagementDialog } from "./connector-access-management-dialog.tsx";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { noConnectorImg } from "../../platform-assets.ts";

const CUSTOM_CONNECTOR_AGENT_NAME_LIMIT = 2;
const CUSTOM_CONNECTOR_AGENT_NAME_MAX_CHARS = 12;

function connectsDirectlyWithOAuth(
  connector: CustomConnectorResponse,
  oauth2Enabled: boolean,
  feishuEnabled: boolean,
): boolean {
  return (
    connector.authMode === "oauth" &&
    (oauth2Enabled ||
      (feishuEnabled && connector.oauthConfig?.providerAdapter === "feishu"))
  );
}

function customConnectorAgentName(
  agent: TeamComposeItem,
  unnamed: string,
): string {
  return agent.displayName ?? unnamed;
}

function truncateCustomConnectorAgentName(name: string): string {
  if (name.length <= CUSTOM_CONNECTOR_AGENT_NAME_MAX_CHARS) {
    return name;
  }
  return `${name.slice(0, CUSTOM_CONNECTOR_AGENT_NAME_MAX_CHARS - 1)}…`;
}

function CustomConnectorAgentUsage({
  agents,
  loading,
  connectorLabel,
  onClick,
}: {
  readonly agents: readonly TeamComposeItem[];
  readonly loading: boolean;
  readonly connectorLabel: string;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  const unnamed = t(($) => {
    return $.connectors.catalog.unnamedAgent;
  });
  if (loading) {
    return (
      <button
        type="button"
        className="inline-flex h-7 min-w-0 shrink items-center rounded-lg px-2"
        aria-label={t(
          ($) => {
            return $.connectors.catalog.access.manage;
          },
          { connector: connectorLabel },
        )}
        onClick={onClick}
      >
        <span className="block h-3 w-20 animate-pulse rounded bg-muted" />
      </button>
    );
  }
  if (agents.length === 0) {
    return (
      <button
        type="button"
        className="inline-flex h-7 min-w-0 shrink items-center rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--gray-50))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t(
          ($) => {
            return $.connectors.catalog.access.manage;
          },
          { connector: connectorLabel },
        )}
        data-testid="custom-connector-card-agent-usage"
        onClick={onClick}
      >
        <span className="truncate underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
          {t(($) => {
            return $.connectors.custom.agentUsage.none;
          })}
        </span>
      </button>
    );
  }

  const visibleNames = agents
    .slice(0, CUSTOM_CONNECTOR_AGENT_NAME_LIMIT)
    .map((agent) => {
      return truncateCustomConnectorAgentName(
        customConnectorAgentName(agent, unnamed),
      );
    });
  const overflowCount = agents.length - visibleNames.length;
  const agentNames = visibleNames.join(", ");
  return (
    <button
      type="button"
      className="inline-flex h-7 min-w-0 shrink items-center rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--gray-50))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={t(
        ($) => {
          return $.connectors.catalog.access.manage;
        },
        { connector: connectorLabel },
      )}
      data-testid="custom-connector-card-agent-usage"
      title={agents
        .map((agent) => {
          return customConnectorAgentName(agent, unnamed);
        })
        .join(", ")}
      onClick={onClick}
    >
      <span className="truncate underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
        {overflowCount > 0
          ? t(
              ($) => {
                return $.connectors.custom.agentUsage.usedByOverflow;
              },
              {
                agents: agentNames,
                count: overflowCount,
                value: formatLocalizedNumber(overflowCount),
              },
            )
          : t(
              ($) => {
                return $.connectors.custom.agentUsage.usedBy;
              },
              { agents: agentNames },
            )}
      </span>
    </button>
  );
}

interface CustomConnectorRowProps {
  readonly connector: CustomConnectorResponse;
  readonly authorizedAgents: readonly TeamComposeItem[];
  readonly authorizedAgentsLoading: boolean;
  readonly isAdmin: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEdit: () => void;
  readonly onRename: () => void;
  readonly onManageAccess: () => void;
  readonly fullEditingEnabled: boolean;
  readonly feishuEnabled: boolean;
  readonly onDelete: () => void;
}

function CustomConnectorCardContent({
  connector,
  authorizedAgents,
  authorizedAgentsLoading,
  hasActions,
  onManageAccess,
}: {
  readonly connector: CustomConnectorResponse;
  readonly authorizedAgents: readonly TeamComposeItem[];
  readonly authorizedAgentsLoading: boolean;
  readonly hasActions: boolean;
  readonly onManageAccess: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex h-14 items-center gap-2.5 px-5">
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={20}
        />
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 text-sm font-medium text-foreground truncate"
        >
          {connector.displayName}
        </span>
      </div>
      <div
        className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
          hasActions ? "pr-12" : "pr-5"
        }`}
      >
        {connector.connected ? (
          <>
            <span className="flex shrink-0 items-center gap-2 truncate text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              {t(($) => {
                return $.connectors.custom.statusConnected;
              })}
            </span>
            <CustomConnectorAgentUsage
              agents={authorizedAgents}
              loading={authorizedAgentsLoading}
              connectorLabel={connector.displayName}
              onClick={onManageAccess}
            />
          </>
        ) : (
          <span
            className="min-w-0 truncate font-mono text-xs text-muted-foreground/60"
            title={connector.prefixes[0]}
          >
            {connector.prefixes[0]}
          </span>
        )}
      </div>
    </>
  );
}

function CustomConnectorRow({
  connector,
  authorizedAgents,
  authorizedAgentsLoading,
  isAdmin,
  onConnect,
  onDisconnect,
  onEdit,
  onRename,
  onManageAccess,
  fullEditingEnabled,
  feishuEnabled,
  onDelete,
}: CustomConnectorRowProps) {
  const { t } = useTranslation();
  const adminCanManage =
    isAdmin && connector.oauthConfig?.providerAdapter !== "feishu";
  const hasActions = connector.connected || adminCanManage;
  const directOAuth = connectsDirectlyWithOAuth(
    connector,
    fullEditingEnabled,
    feishuEnabled,
  );
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      authorizedAgents={authorizedAgents}
      authorizedAgentsLoading={authorizedAgentsLoading}
      hasActions={hasActions}
      onManageAccess={onManageAccess}
    />
  );

  return (
    <div className="relative">
      {connector.connected ? (
        <div className="zero-card flex flex-col">{cardContent}</div>
      ) : (
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.connectors.card.connectAria;
            },
            { connector: connector.displayName },
          )}
          className="zero-card flex w-full cursor-pointer flex-col text-left"
          onClick={onConnect}
        >
          {cardContent}
        </button>
      )}
      {hasActions && (
        <div className="absolute bottom-2 right-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                aria-label={t(($) => {
                  return $.connectors.custom.moreOptions;
                })}
              >
                <IconDotsVertical size={14} stroke={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {!connector.connected && directOAuth && (
                <DropdownMenuItem onClick={onConnect}>
                  {t(($) => {
                    return $.connectors.actions.connect;
                  })}
                </DropdownMenuItem>
              )}
              {!connector.connected && !directOAuth && (
                <DropdownMenuModalItem onModalSelect={onConnect}>
                  {t(($) => {
                    return $.connectors.actions.connect;
                  })}
                </DropdownMenuModalItem>
              )}
              {connector.connected && (
                <DropdownMenuItem onClick={onDisconnect}>
                  {t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
                </DropdownMenuItem>
              )}
              {adminCanManage && (
                <>
                  <DropdownMenuModalItem
                    onModalSelect={fullEditingEnabled ? onEdit : onRename}
                  >
                    {fullEditingEnabled
                      ? t(($) => {
                          return $.connectors.actions.edit;
                        })
                      : t(($) => {
                          return $.connectors.actions.rename;
                        })}
                  </DropdownMenuModalItem>
                  <DropdownMenuModalItem
                    onModalSelect={onDelete}
                    className="text-destructive focus:text-destructive"
                  >
                    {t(($) => {
                      return $.connectors.actions.delete;
                    })}
                  </DropdownMenuModalItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

function CustomConnectorDialogs() {
  const dialog = useGet(customConnectorDialog$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  return (
    <>
      {dialog.kind === "create" && <CustomConnectorCreateDialog />}
      {dialog.kind === "edit" && (
        <CustomConnectorCreateDialog connector={dialog.connector} />
      )}
      {dialog.kind === "rename" && (
        <CustomConnectorRenameDialog
          id={dialog.connector.id}
          currentDisplayName={dialog.connector.displayName}
        />
      )}
      {dialog.kind === "connect" && (
        <CustomConnectorConnectDialog connector={dialog.connector} />
      )}
      {dialog.kind === "access" && (
        <CustomConnectorAccessManagementDialog
          connector={dialog.connector}
          onClose={closeDialog}
        />
      )}
      {dialog.kind === "delete" && (
        <CustomConnectorDeleteConfirm
          id={dialog.connector.id}
          displayName={dialog.connector.displayName}
        />
      )}
    </>
  );
}

export function CustomConnectorsPanel() {
  const { t } = useTranslation();
  const connectors = useLastResolved(customConnectors$);
  const authorizedAgentsByIdLoadable = useLastLoadable(
    customConnectorAuthorizedAgentsById$,
  );
  const authorizedAgentsById =
    authorizedAgentsByIdLoadable.state === "hasData"
      ? authorizedAgentsByIdLoadable.data
      : new Map<string, readonly TeamComposeItem[]>();
  const authorizedAgentsLoading =
    authorizedAgentsByIdLoadable.state === "loading";
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const featureSwitches = useGet(featureSwitch$);
  const fullEditingEnabled =
    featureSwitches[FeatureSwitchKey.CustomConnectorOAuth2] ?? false;
  const feishuEnabled =
    featureSwitches[FeatureSwitchKey.FeishuIntegration] ?? false;
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openRename = useSet(openCustomConnectorRenameDialog$);
  const openAccess = useSet(openCustomConnectorAccessDialog$);
  const openConnect = useSet(openCustomConnectorConnectDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
  const connectOAuth2 = useSet(connectCustomConnectorOAuth2$);
  const setRenameInput = useSet(setCustomConnectorRenameInput$);
  const clearSecret = useSet(clearCustomConnectorSecret$);
  const signal = useGet(pageSignal$);

  const handleDisconnect = (connector: CustomConnectorResponse) => {
    detach(clearSecret(connector.id, signal), Reason.DomCallback);
  };

  const handleRename = (connector: CustomConnectorResponse) => {
    setRenameInput(connector.displayName);
    openRename(connector);
  };

  const handleConnect = (connector: CustomConnectorResponse) => {
    if (
      connectsDirectlyWithOAuth(connector, fullEditingEnabled, feishuEnabled)
    ) {
      detach(connectOAuth2(connector.id, signal), Reason.DomCallback);
      return;
    }
    openConnect(connector);
  };

  return (
    <section className="flex flex-col gap-3">
      {connectors && connectors.length === 0 && (
        <div className="zero-card py-12 flex flex-col items-center gap-3">
          <img
            src={noConnectorImg}
            alt={t(($) => {
              return $.connectors.catalog.noConnectorsAlt;
            })}
            className="h-20 w-20 object-contain opacity-80"
          />
          <p className="text-sm text-muted-foreground text-center">
            {isAdmin
              ? t(($) => {
                  return $.connectors.custom.emptyAdmin;
                })
              : t(($) => {
                  return $.connectors.custom.emptyMember;
                })}
          </p>
        </div>
      )}

      {connectors && connectors.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {connectors.map((c) => {
            return (
              <CustomConnectorRow
                key={c.id}
                connector={c}
                authorizedAgents={authorizedAgentsById.get(c.id) ?? []}
                authorizedAgentsLoading={authorizedAgentsLoading}
                isAdmin={isAdmin}
                onConnect={() => {
                  return handleConnect(c);
                }}
                onDisconnect={() => {
                  return handleDisconnect(c);
                }}
                onEdit={() => {
                  return openEdit(c);
                }}
                onRename={() => {
                  return handleRename(c);
                }}
                onManageAccess={() => {
                  return openAccess(c);
                }}
                fullEditingEnabled={fullEditingEnabled}
                feishuEnabled={feishuEnabled}
                onDelete={() => {
                  return openDelete(c);
                }}
              />
            );
          })}
        </div>
      )}

      <CustomConnectorDialogs />
    </section>
  );
}
