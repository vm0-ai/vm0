import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
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
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  disconnectCustomConnector$,
  closeCustomConnectorDialog$,
  connectCustomConnectorAccountOAuth2$,
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
import {
  ConnectorAgentAccessButton,
  connectorAgentAccessStatus,
} from "./connector-agent-access-button.tsx";
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

  return (
    <ConnectorAgentAccessButton
      agents={authorizedAgents}
      status={connectorAgentAccessStatus(authorizedAgentsByIdLoadable.state)}
      allowAccessIncrease={allowAccessIncrease}
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
  return (
    <div
      className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
        hasActions ? "pr-12" : "pr-2"
      }`}
    >
      {accountManagement ? (
        <ConnectorAccountSummaryText
          summary={accountSummary}
          status={accountSummaryStatus}
          className="min-w-0 flex-1 text-xs text-muted-foreground"
        />
      ) : (
        <CustomConnectorConnectionStatus connected={connector.connected} />
      )}
      {connector.connected || accountManagement ? (
        <div className="relative z-20 min-w-0 max-w-full">
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
  return (
    <div
      className={`zero-card relative flex flex-col ${canActivate ? "cursor-pointer" : ""}`}
    >
      {canActivate ? (
        <button
          type="button"
          aria-label={t(
            ($) => {
              return managesAccounts
                ? $.connectors.accounts.managerTitle
                : $.connectors.card.connectAria;
            },
            { connector: connectorLabel },
          )}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={onActivate}
        />
      ) : null}
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
    <div className="absolute bottom-2 right-2 z-20">
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
  const connectionActionsEnabled = mcpActionsEnabled;
  const adminCanEdit = adminCanDelete && mcpActionsEnabled;
  const accountCount = accountSummary?.accountCount ?? 0;
  const canActivate = accountManagement
    ? accountSummaryStatus === "ready" &&
      (accountCount > 0 || connectionActionsEnabled)
    : connectionActionsEnabled && !connector.connected;
  const activate =
    accountManagement && accountCount > 0 ? onManageAccounts : onConnect;
  const managesAccounts = accountManagement && accountCount > 0;
  const hasActions = connector.connected || adminCanDelete;
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      hasActions={hasActions}
      allowAccessIncrease={
        connectionActionsEnabled && (!accountManagement || accountCount > 0)
      }
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
  const accountManagement =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorAccounts] ?? false;
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const accessAccountSummary =
    dialog.kind === "access" && accountSummariesLoadable.state === "hasData"
      ? accountSummariesLoadable.data.get(`custom:${dialog.connector.id}`)
      : undefined;
  const allowAccessIncrease =
    dialog.kind === "access" &&
    (dialog.connector.kind === "http" || mcpEnabled) &&
    (!accountManagement ||
      (accountSummariesLoadable.state === "hasData" &&
        (accessAccountSummary?.accountCount ?? 0) > 0));
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
          allowAccessIncrease={allowAccessIncrease}
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
      detach(connectOAuth2({ id: connector.id }, signal), Reason.DomCallback);
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
            accountSummaryStatus={accountSummaryStatus}
            accountManagement={connectorAccountsEnabled}
            onManageAccounts={() => {
              return openAccountManager(connector, signal);
            }}
          />
        );
      })}
    </div>
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
              connectionId: account.id,
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
      <CustomAccountDialogs mcpEnabled={mcpEnabled} />
    </section>
  );
}
