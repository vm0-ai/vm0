import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { EllipsisVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  disconnectCustomConnector$,
  closeCustomConnectorDialog$,
  connectCustomConnectorOAuth2$,
  customConnectorAuthorizedAgentsById$,
  customConnectorDialog$,
  customConnectors$,
  openCustomConnectorAccessDialog$,
  openCustomConnectorConnectDialog$,
  openCustomConnectorDeleteDialog$,
  openCustomConnectorEditDialog$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  customConnectorMcpEnabled$,
  featureSwitch$,
} from "../../../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { CustomConnectorCreateDialog } from "./custom-connector-create-dialog.tsx";
import { CustomConnectorConnectDialog } from "./custom-connector-connect-dialog.tsx";
import { CustomConnectorDeleteConfirm } from "./custom-connector-delete-confirm.tsx";
import { CustomConnectorAccessManagementDialog } from "./connector-access-management-dialog.tsx";
import { ConnectorAgentAccessButton } from "./connector-agent-access-button.tsx";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { noConnectorImg } from "../../platform-assets.ts";
import { customConnectorTarget } from "./custom-connector-display.ts";
import {
  connectorAccountSummaryByTarget$,
  reloadConnectorAccountSummaries$,
  settingsConnectorAccounts,
} from "../../../../signals/okou-page/settings/connector-accounts.ts";
import { connectorAccountEffectiveLabel } from "../../../../signals/connector-domain.ts";
import { ConnectorAccountManagerDialog } from "./connector-account-manager-dialog.tsx";
import {
  closeCustomAccountConnectDialog$,
  closeCustomAccountManager$,
  customAccountConnectDialog$,
  customAccountManager$,
  openCustomAccountConnectDialog$,
  openCustomAccountManager$,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";

function connectsDirectlyWithOAuth(
  connector: CustomConnectorResponse,
): boolean {
  return connector.authMode === "oauth";
}

interface CustomConnectorRowProps {
  readonly connector: CustomConnectorResponse;
  readonly isAdmin: boolean;
  readonly mcpEnabled: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEdit: () => void;
  readonly onManageAccess: () => void;
  readonly onDelete: () => void;
  readonly accountSummary?: ConnectorAccountSummary;
  readonly accountManagement: boolean;
  readonly canAddAccount: boolean;
  readonly onManageAccounts: () => void;
}

function CustomConnectorAgentAccess({
  connector,
  allowAccessIncrease,
  onManageAccess,
}: {
  readonly connector: CustomConnectorResponse;
  readonly allowAccessIncrease: boolean;
  readonly onManageAccess: () => void;
}) {
  const authorizedAgentsByIdLoadable = useLastLoadable(
    customConnectorAuthorizedAgentsById$,
  );
  const authorizedAgents =
    authorizedAgentsByIdLoadable.state === "hasData"
      ? (authorizedAgentsByIdLoadable.data.get(connector.id) ?? [])
      : [];

  if (!allowAccessIncrease && authorizedAgents.length === 0) {
    return null;
  }

  return (
    <ConnectorAgentAccessButton
      agents={authorizedAgents}
      loading={authorizedAgentsByIdLoadable.state === "loading"}
      connectorLabel={connector.displayName}
      onClick={onManageAccess}
    />
  );
}

interface CustomConnectorCardContentProps {
  readonly connector: CustomConnectorResponse;
  readonly hasActions: boolean;
  readonly canConnect: boolean;
  readonly allowAccessIncrease: boolean;
  readonly onConnect: () => void;
  readonly onManageAccess: () => void;
  readonly accountSummary?: ConnectorAccountSummary;
  readonly accountManagement: boolean;
  readonly canAddAccount: boolean;
  readonly onManageAccounts: () => void;
}

function CustomConnectorHeaderContent({
  connector,
}: {
  readonly connector: CustomConnectorResponse;
}) {
  const { t } = useTranslation();
  const connectorType =
    connector.kind === "mcp"
      ? t(($) => {
          return $.connectors.custom.mcpType;
        })
      : t(($) => {
          return $.connectors.custom.create.httpType;
        });
  const connectorTarget = customConnectorTarget(connector);
  return (
    <>
      <CustomConnectorIcon
        id={connector.id}
        displayName={connector.displayName}
        size={20}
      />
      <span className="min-w-0 flex-1">
        <span
          data-testid="connector-card-label"
          className="block truncate text-sm font-medium text-foreground"
        >
          {connector.displayName}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">{connectorType}</span>
          <span aria-hidden="true">·</span>
          <span
            className="min-w-0 truncate font-mono text-muted-foreground/60"
            title={connectorTarget}
          >
            {connectorTarget}
          </span>
        </span>
      </span>
    </>
  );
}

function CustomConnectorCardHeader({
  connector,
  canConnect,
  onConnect,
}: Pick<
  CustomConnectorCardContentProps,
  "connector" | "canConnect" | "onConnect"
>) {
  const { t } = useTranslation();
  const content = <CustomConnectorHeaderContent connector={connector} />;
  return !connector.connected && canConnect ? (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.connectors.card.connectAria;
        },
        { connector: connector.displayName },
      )}
      className="flex h-14 w-full cursor-pointer items-center gap-2.5 px-5 text-left"
      onClick={onConnect}
    >
      {content}
    </button>
  ) : (
    <div className="flex h-14 items-center gap-2.5 px-5">{content}</div>
  );
}

function CustomConnectorAccountSummary({
  connector,
  accountSummary,
}: {
  readonly connector: CustomConnectorResponse;
  readonly accountSummary: ConnectorAccountSummary | undefined;
}) {
  const { t } = useTranslation();
  const accountCount = accountSummary?.accountCount ?? 0;
  let accountSummaryText =
    accountCount === 0
      ? t(($) => {
          return $.connectors.accounts.noAccounts;
        })
      : accountCount === 1
        ? t(
            ($) => {
              return $.connectors.accounts.summaryOne;
            },
            { value: accountCount },
          )
        : t(
            ($) => {
              return $.connectors.accounts.summaryMany;
            },
            { value: accountCount },
          );
  if (accountSummary?.defaultConnection) {
    accountSummaryText = t(
      ($) => {
        return $.connectors.accounts.summaryWithDefault;
      },
      {
        summary: accountSummaryText,
        account: connectorAccountEffectiveLabel(
          accountSummary.defaultConnection,
          connector.displayName,
        ),
      },
    );
  }
  if (accountSummary && accountSummary.attentionCount > 0) {
    accountSummaryText = t(
      ($) => {
        return $.connectors.accounts.summaryWithAttention;
      },
      { summary: accountSummaryText, value: accountSummary.attentionCount },
    );
  }
  return (
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      {accountSummaryText}
    </span>
  );
}

function CustomConnectorConnectionStatus({
  connected,
}: {
  readonly connected: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-2 truncate text-xs text-muted-foreground">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          connected ? "bg-emerald-500" : "bg-muted-foreground/50"
        }`}
      />
      {connected
        ? t(($) => {
            return $.connectors.custom.statusConnected;
          })
        : t(($) => {
            return $.connectors.catalog.filters.notConnected;
          })}
    </span>
  );
}

function CustomConnectorCardFooter({
  connector,
  hasActions,
  allowAccessIncrease,
  onConnect,
  onManageAccess,
  accountSummary,
  accountManagement,
  canAddAccount,
  onManageAccounts,
}: Omit<CustomConnectorCardContentProps, "canConnect">) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
        hasActions ? "pr-12" : "pr-2"
      }`}
    >
      {accountManagement ? (
        <CustomConnectorAccountSummary
          connector={connector}
          accountSummary={accountSummary}
        />
      ) : (
        <CustomConnectorConnectionStatus connected={connector.connected} />
      )}
      {connector.connected || accountManagement ? (
        <CustomConnectorAgentAccess
          connector={connector}
          allowAccessIncrease={allowAccessIncrease}
          onManageAccess={onManageAccess}
        />
      ) : null}
      {accountManagement ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!canAddAccount}
            onClick={onConnect}
          >
            {t(($) => {
              return $.connectors.accounts.add;
            })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={(accountSummary?.accountCount ?? 0) === 0}
            onClick={onManageAccounts}
          >
            {t(($) => {
              return $.connectors.accounts.manage;
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CustomConnectorCardContent(props: CustomConnectorCardContentProps) {
  return (
    <>
      <CustomConnectorCardHeader
        connector={props.connector}
        canConnect={props.canConnect}
        onConnect={props.onConnect}
      />
      <CustomConnectorCardFooter {...props} />
    </>
  );
}

function CustomConnectorRow({
  connector,
  isAdmin,
  mcpEnabled,
  onConnect,
  onDisconnect,
  onEdit,
  onManageAccess,
  onDelete,
  accountSummary,
  accountManagement,
  canAddAccount,
  onManageAccounts,
}: CustomConnectorRowProps) {
  const { t } = useTranslation();
  const adminCanDelete = isAdmin;
  const mcpActionsEnabled = connector.kind === "http" || mcpEnabled;
  const adminCanEdit = adminCanDelete && mcpActionsEnabled;
  const canConnect =
    mcpActionsEnabled && !accountManagement && !connector.connected;
  const hasActions = connector.connected || adminCanDelete;
  const directOAuth = connectsDirectlyWithOAuth(connector);
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      hasActions={hasActions}
      canConnect={canConnect}
      allowAccessIncrease={mcpActionsEnabled}
      onConnect={onConnect}
      onManageAccess={onManageAccess}
      accountSummary={accountSummary}
      accountManagement={accountManagement}
      canAddAccount={canAddAccount}
      onManageAccounts={onManageAccounts}
    />
  );

  return (
    <div className="relative">
      <div className="zero-card flex flex-col">{cardContent}</div>
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
                <EllipsisVertical size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {canConnect && directOAuth && (
                <DropdownMenuItem onClick={onConnect}>
                  {t(($) => {
                    return $.connectors.actions.connect;
                  })}
                </DropdownMenuItem>
              )}
              {canConnect && !directOAuth && (
                <DropdownMenuModalItem onModalSelect={onConnect}>
                  {t(($) => {
                    return $.connectors.actions.connect;
                  })}
                </DropdownMenuModalItem>
              )}
              {connector.connected && !accountManagement && (
                <DropdownMenuItem onClick={onDisconnect}>
                  {t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
                </DropdownMenuItem>
              )}
              {adminCanEdit && (
                <DropdownMenuModalItem onModalSelect={onEdit}>
                  {t(($) => {
                    return $.connectors.actions.edit;
                  })}
                </DropdownMenuModalItem>
              )}
              {adminCanDelete && (
                <DropdownMenuModalItem
                  onModalSelect={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  {t(($) => {
                    return $.connectors.actions.delete;
                  })}
                </DropdownMenuModalItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

function CustomConnectorDialogs({
  mcpEnabled,
}: {
  readonly mcpEnabled: boolean;
}) {
  const dialog = useGet(customConnectorDialog$);
  const closeDialog = useSet(closeCustomConnectorDialog$);
  return (
    <>
      {dialog.kind === "create" && <CustomConnectorCreateDialog />}
      {dialog.kind === "edit" && (
        <CustomConnectorCreateDialog connector={dialog.connector} />
      )}
      {dialog.kind === "connect" && (
        <CustomConnectorConnectDialog connector={dialog.connector} />
      )}
      {dialog.kind === "access" && (
        <CustomConnectorAccessManagementDialog
          connector={dialog.connector}
          allowAccessIncrease={dialog.connector.kind === "http" || mcpEnabled}
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

function CustomConnectorEmptyState({ isAdmin }: { readonly isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
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
  );
}

function CustomConnectorGrid({
  connectors,
  isAdmin,
  mcpEnabled,
}: {
  readonly connectors: readonly CustomConnectorResponse[];
  readonly isAdmin: boolean;
  readonly mcpEnabled: boolean;
}) {
  const connectorAccountsEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorAccounts] ?? false;
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openAccess = useSet(openCustomConnectorAccessDialog$);
  const openConnect = useSet(openCustomConnectorConnectDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
  const connectOAuth2 = useSet(connectCustomConnectorOAuth2$);
  const disconnect = useSet(disconnectCustomConnector$);
  const signal = useGet(pageSignal$);
  const openAccountManager = useSet(openCustomAccountManager$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const handleDisconnect = (connector: CustomConnectorResponse) => {
    detach(disconnect(connector.id, signal), Reason.DomCallback);
  };

  const handleConnect = (connector: CustomConnectorResponse) => {
    if (connectorAccountsEnabled) {
      openAccountConnect(connector, { kind: "add" });
      return;
    }
    if (connectsDirectlyWithOAuth(connector)) {
      detach(connectOAuth2(connector.id, signal), Reason.DomCallback);
      return;
    }
    openConnect(connector);
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {connectors.map((connector) => {
        const accountSummary =
          accountSummariesLoadable.state === "hasData"
            ? accountSummariesLoadable.data.get(`custom:${connector.id}`)
            : undefined;
        return (
          <CustomConnectorRow
            key={connector.id}
            connector={connector}
            isAdmin={isAdmin}
            mcpEnabled={mcpEnabled}
            onConnect={() => {
              return handleConnect(connector);
            }}
            onDisconnect={() => {
              return handleDisconnect(connector);
            }}
            onEdit={() => {
              return openEdit(connector);
            }}
            onManageAccess={() => {
              return openAccess(connector);
            }}
            onDelete={() => {
              return openDelete(connector);
            }}
            accountSummary={accountSummary}
            accountManagement={connectorAccountsEnabled}
            canAddAccount={
              connectorAccountsEnabled &&
              (connector.kind === "http" || mcpEnabled)
            }
            onManageAccounts={() => {
              return openAccountManager(connector);
            }}
          />
        );
      })}
    </div>
  );
}

function CustomAccountDialogs() {
  const managedAccounts = useGet(customAccountManager$);
  const accountConnect = useGet(customAccountConnectDialog$);
  const closeAccountManager = useSet(closeCustomAccountManager$);
  const closeAccountConnect = useSet(closeCustomAccountConnectDialog$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const reloadAccountSummaries = useSet(reloadConnectorAccountSummaries$);
  const reloadAccountList = useSet(settingsConnectorAccounts.reload$);
  return (
    <>
      {accountConnect ? (
        <CustomConnectorConnectDialog
          connector={accountConnect.connector}
          accountMode={accountConnect.mode}
          onClose={closeAccountConnect}
          onSuccess={() => {
            reloadAccountSummaries();
            reloadAccountList();
          }}
        />
      ) : null}
      {managedAccounts ? (
        <ConnectorAccountManagerDialog
          target={{ kind: "custom", customConnectorId: managedAccounts.id }}
          connectorLabel={managedAccounts.displayName}
          icon={
            <CustomConnectorIcon
              id={managedAccounts.id}
              displayName={managedAccounts.displayName}
              size={20}
            />
          }
          onClose={closeAccountManager}
          onAdd={() => {
            openAccountConnect(managedAccounts, { kind: "add" });
          }}
          onReconnect={(account) => {
            openAccountConnect(managedAccounts, {
              kind: "reconnect",
              account,
            });
          }}
        />
      ) : null}
    </>
  );
}

export function CustomConnectorsPanel() {
  const connectors = useLastResolved(customConnectors$);
  const userManagedConnectors = connectors?.filter((connector) => {
    return !isIntegrationManagedCustomConnector(connector);
  });
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const mcpEnabled = useGet(customConnectorMcpEnabled$);

  return (
    <section className="flex flex-col gap-3">
      {userManagedConnectors?.length === 0 ? (
        <CustomConnectorEmptyState isAdmin={isAdmin} />
      ) : null}
      {userManagedConnectors && userManagedConnectors.length > 0 ? (
        <CustomConnectorGrid
          connectors={userManagedConnectors}
          isAdmin={isAdmin}
          mcpEnabled={mcpEnabled}
        />
      ) : null}
      <CustomConnectorDialogs mcpEnabled={mcpEnabled} />
      <CustomAccountDialogs />
    </section>
  );
}
