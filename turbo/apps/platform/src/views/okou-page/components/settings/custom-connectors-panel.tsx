import { useGet, useLoadable, useLastLoadable, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  disconnectCustomConnector$,
  closeCustomConnectorDialog$,
  connectCustomConnectorAccountOAuth2$,
  connectCustomConnectorOAuth2$,
  customConnectorAuthorizedAgentsById$,
  customConnectorDialog$,
  openCustomConnectorAccessDialog$,
  openCustomConnectorConnectDialog$,
  openCustomConnectorDeleteDialog$,
  openCustomConnectorEditDialog$,
} from "../../../../signals/okou-page/settings/custom-connectors.ts";
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
import { connectorAccountSummaryByTarget$ } from "../../../../signals/okou-page/connector-accounts.ts";
import { ConnectorAccountManagerDialog } from "./connector-account-manager-dialog.tsx";
import {
  ConnectorAccountSummaryText,
  connectorAccountSummaryStatus,
  type ConnectorAccountSummaryStatus,
} from "./connector-card.tsx";
import {
  closeCustomAccountConnectDialog$,
  closeCustomAccountManager$,
  customAccountConnectDialog$,
  customAccountManager$,
  finishConnectorAccountConnection$,
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
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
  readonly accountManagement: boolean;
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
  readonly allowAccessIncrease: boolean;
  readonly onManageAccess: () => void;
  readonly accountSummary?: ConnectorAccountSummary;
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
  readonly accountManagement: boolean;
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
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-testid="connector-card-label"
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {connector.displayName}
          </span>
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            {t(($) => {
              return $.connectors.catalog.types.custom;
            })}
          </span>
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
}: Pick<CustomConnectorCardContentProps, "connector">) {
  return (
    <div className="flex h-14 items-center gap-2.5 px-5">
      <CustomConnectorHeaderContent connector={connector} />
    </div>
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
  onManageAccess,
  accountSummary,
  accountSummaryStatus,
  accountManagement,
}: Omit<CustomConnectorCardContentProps, "canConnect">) {
  const { t } = useTranslation();
  const accountCount = accountSummary?.accountCount ?? 0;
  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
        hasActions ? "pr-12" : "pr-2"
      }`}
    >
      {accountManagement ? (
        accountSummaryStatus === "ready" ? (
          <div className="min-w-0 flex-1">
            <CustomConnectorConnectionStatus connected={accountCount > 0} />
            {accountCount > 1 ? (
              <span className="ml-2 text-xs text-muted-foreground">
                ·{" "}
                {t(
                  ($) => {
                    return $.connectors.accounts.summaryMany;
                  },
                  { value: accountCount },
                )}
              </span>
            ) : null}
          </div>
        ) : (
          <ConnectorAccountSummaryText
            summary={accountSummary}
            status={accountSummaryStatus}
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          />
        )
      ) : (
        <CustomConnectorConnectionStatus connected={connector.connected} />
      )}
      {connector.connected || (accountManagement && accountCount > 0) ? (
        <div
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
        >
          <CustomConnectorAgentAccess
            connector={connector}
            allowAccessIncrease={allowAccessIncrease}
            onManageAccess={onManageAccess}
          />
        </div>
      ) : null}
    </div>
  );
}

function CustomConnectorCardContent(props: CustomConnectorCardContentProps) {
  return (
    <>
      <CustomConnectorCardHeader connector={props.connector} />
      <CustomConnectorCardFooter {...props} />
    </>
  );
}

function CustomConnectorActivationCard({
  connectorLabel,
  canActivate,
  managesAccounts,
  onActivate,
  children,
}: {
  readonly connectorLabel: string;
  readonly canActivate: boolean;
  readonly managesAccounts: boolean;
  readonly onActivate: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const activate = () => {
    if (canActivate) {
      onActivate();
    }
  };
  return (
    <div
      role={canActivate ? "button" : undefined}
      tabIndex={canActivate ? 0 : undefined}
      aria-label={
        canActivate
          ? t(
              ($) => {
                return managesAccounts
                  ? $.connectors.accounts.managerTitle
                  : $.connectors.card.connectAria;
              },
              { connector: connectorLabel },
            )
          : undefined
      }
      className={`zero-card flex flex-col ${canActivate ? "cursor-pointer" : ""}`}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      {children}
    </div>
  );
}

function CustomConnectorActions({
  connector,
  hasActions,
  canActivate,
  accountManagement,
  adminCanEdit,
  adminCanDelete,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  readonly connector: CustomConnectorResponse;
  readonly hasActions: boolean;
  readonly canActivate: boolean;
  readonly accountManagement: boolean;
  readonly adminCanEdit: boolean;
  readonly adminCanDelete: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  if (!hasActions) {
    return null;
  }
  const directOAuth = connectsDirectlyWithOAuth(connector);
  return (
    <div className="absolute bottom-2 right-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            showTooltip
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
          {canActivate && !accountManagement && directOAuth ? (
            <DropdownMenuItem onClick={onConnect}>
              {t(($) => {
                return $.connectors.actions.connect;
              })}
            </DropdownMenuItem>
          ) : null}
          {canActivate && !accountManagement && !directOAuth ? (
            <DropdownMenuModalItem onModalSelect={onConnect}>
              {t(($) => {
                return $.connectors.actions.connect;
              })}
            </DropdownMenuModalItem>
          ) : null}
          {connector.connected && !accountManagement ? (
            <DropdownMenuItem onClick={onDisconnect}>
              {t(($) => {
                return $.connectors.actions.disconnect;
              })}
            </DropdownMenuItem>
          ) : null}
          {adminCanEdit ? (
            <DropdownMenuModalItem onModalSelect={onEdit}>
              {t(($) => {
                return $.connectors.actions.edit;
              })}
            </DropdownMenuModalItem>
          ) : null}
          {adminCanDelete ? (
            <DropdownMenuModalItem
              onModalSelect={onDelete}
              className="text-destructive focus:text-destructive"
            >
              {t(($) => {
                return $.connectors.actions.delete;
              })}
            </DropdownMenuModalItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
  accountSummaryStatus,
  accountManagement,
  onManageAccounts,
}: CustomConnectorRowProps) {
  const adminCanDelete = isAdmin;
  const mcpActionsEnabled = connector.kind === "http" || mcpEnabled;
  const adminCanEdit = adminCanDelete && mcpActionsEnabled;
  const accountCount = accountSummary?.accountCount ?? 0;
  const canActivate = accountManagement
    ? accountSummaryStatus === "ready" &&
      (accountCount > 0 || mcpActionsEnabled)
    : mcpActionsEnabled && !connector.connected;
  const activate =
    accountManagement && accountCount > 0 ? onManageAccounts : onConnect;
  const managesAccounts = accountManagement && accountCount > 0;
  const hasActions = connector.connected || adminCanDelete;
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      hasActions={hasActions}
      allowAccessIncrease={mcpActionsEnabled}
      onManageAccess={onManageAccess}
      accountSummary={accountSummary}
      accountSummaryStatus={accountSummaryStatus}
      accountManagement={accountManagement}
    />
  );

  return (
    <div className="relative">
      <CustomConnectorActivationCard
        connectorLabel={connector.displayName}
        canActivate={canActivate}
        managesAccounts={managesAccounts}
        onActivate={activate}
      >
        {cardContent}
      </CustomConnectorActivationCard>
      <CustomConnectorActions
        connector={connector}
        hasActions={hasActions}
        canActivate={canActivate}
        accountManagement={accountManagement}
        adminCanEdit={adminCanEdit}
        adminCanDelete={adminCanDelete}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onEdit={onEdit}
        onDelete={onDelete}
      />
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

export function CustomConnectorDirectoryEmptyState({
  isAdmin,
}: {
  readonly isAdmin: boolean;
}) {
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
  const accountSummaryStatus = connectorAccountSummaryStatus(
    accountSummariesLoadable.state,
  );
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openAccess = useSet(openCustomConnectorAccessDialog$);
  const openConnect = useSet(openCustomConnectorConnectDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
  const connectOAuth2 = useSet(connectCustomConnectorOAuth2$);
  const connectAccountOAuth2 = useSet(connectCustomConnectorAccountOAuth2$);
  const disconnect = useSet(disconnectCustomConnector$);
  const signal = useGet(pageSignal$);
  const openAccountManager = useSet(openCustomAccountManager$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const handleDisconnect = (connector: CustomConnectorResponse) => {
    detach(disconnect(connector.id, signal), Reason.DomCallback);
  };

  const finishExplicitAccountAdd = async (
    connector: CustomConnectorResponse,
    connectionId: string | null,
  ): Promise<void> => {
    await finishAccountConnection(
      {
        target: { kind: "custom", customConnectorId: connector.id },
        connectionId,
        connectorLabel: connector.displayName,
        mode: { kind: "add" },
      },
      signal,
    );
  };
  const handleConnect = (connector: CustomConnectorResponse) => {
    if (connectorAccountsEnabled) {
      if (connectsDirectlyWithOAuth(connector)) {
        detach(
          (async () => {
            const result = await connectAccountOAuth2(
              { id: connector.id, account: { intent: "add" } },
              signal,
            );
            if (result.connected) {
              await finishExplicitAccountAdd(connector, result.connectionId);
            }
          })(),
          Reason.DomCallback,
        );
        return;
      }
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
    <>
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
            accountSummaryStatus={accountSummaryStatus}
            accountManagement={connectorAccountsEnabled}
            onManageAccounts={() => {
              return openAccountManager(connector, signal);
            }}
          />
        );
      })}
    </>
  );
}

function CustomAccountDialogs({
  mcpEnabled,
}: {
  readonly mcpEnabled: boolean;
}) {
  const managedAccounts = useGet(customAccountManager$);
  const accountConnect = useGet(customAccountConnectDialog$);
  const closeAccountManager = useSet(closeCustomAccountManager$);
  const closeAccountConnect = useSet(closeCustomAccountConnectDialog$);
  const openAccountConnect = useSet(openCustomAccountConnectDialog$);
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const connectAccountOAuth2 = useSet(connectCustomConnectorAccountOAuth2$);
  const signal = useGet(pageSignal$);
  return (
    <>
      {accountConnect ? (
        <CustomConnectorConnectDialog
          connector={accountConnect.connector}
          accountMode={accountConnect.mode}
          onClose={closeAccountConnect}
          onSuccess={async (connectionId) => {
            await finishAccountConnection(
              {
                target: {
                  kind: "custom",
                  customConnectorId: accountConnect.connector.id,
                },
                connectionId,
                connectorLabel: accountConnect.connector.displayName,
                mode: accountConnect.mode,
              },
              signal,
            );
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
          connectionActionsEnabled={
            managedAccounts.kind === "http" || mcpEnabled
          }
          onClose={closeAccountManager}
          onAdd={() => {
            closeAccountManager();
            if (connectsDirectlyWithOAuth(managedAccounts)) {
              detach(
                (async () => {
                  const result = await connectAccountOAuth2(
                    { id: managedAccounts.id, account: { intent: "add" } },
                    signal,
                  );
                  if (result.connected) {
                    await finishAccountConnection(
                      {
                        target: {
                          kind: "custom",
                          customConnectorId: managedAccounts.id,
                        },
                        connectionId: result.connectionId,
                        connectorLabel: managedAccounts.displayName,
                        mode: { kind: "add" },
                      },
                      signal,
                    );
                  }
                })(),
                Reason.DomCallback,
              );
              return;
            }
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

export function CustomConnectorDirectoryCards({
  connectors,
  isAdmin,
}: {
  readonly connectors: readonly CustomConnectorResponse[];
  readonly isAdmin: boolean;
}) {
  const mcpEnabled = useGet(customConnectorMcpEnabled$);
  return (
    <CustomConnectorGrid
      connectors={connectors}
      isAdmin={isAdmin}
      mcpEnabled={mcpEnabled}
    />
  );
}

export function CustomConnectorDirectoryOverlays() {
  const mcpEnabled = useGet(customConnectorMcpEnabled$);
  return (
    <>
      <CustomConnectorDialogs mcpEnabled={mcpEnabled} />
      <CustomAccountDialogs mcpEnabled={mcpEnabled} />
    </>
  );
}
