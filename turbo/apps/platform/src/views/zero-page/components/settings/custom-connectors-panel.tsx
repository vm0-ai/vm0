import {
  useGet,
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
} from "@vm0/ui";
import {
  isHttpCustomConnectorResponse,
  type CustomConnectorHttpResponse,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
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
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
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

function connectsDirectlyWithOAuth(
  connector: CustomConnectorResponse,
): boolean {
  return connector.authMode === "oauth";
}

interface CustomConnectorRowProps {
  readonly connector: CustomConnectorResponse;
  readonly isAdmin: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEdit: () => void;
  readonly onManageAccess: () => void;
  readonly onDelete: () => void;
}

function CustomConnectorAgentAccess({
  connector,
  onManageAccess,
}: {
  readonly connector: CustomConnectorHttpResponse;
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
      loading={authorizedAgentsByIdLoadable.state === "loading"}
      connectorLabel={connector.displayName}
      onClick={onManageAccess}
    />
  );
}

function CustomConnectorCardContent({
  connector,
  hasActions,
  onConnect,
  onManageAccess,
}: {
  readonly connector: CustomConnectorResponse;
  readonly hasActions: boolean;
  readonly onConnect: () => void;
  readonly onManageAccess: () => void;
}) {
  const { t } = useTranslation();
  const headerContent = (
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
        {connector.kind === "mcp" ? (
          <span className="block truncate text-xs text-muted-foreground">
            {t(($) => {
              return $.connectors.custom.mcpStreamableHttp;
            })}
          </span>
        ) : !connector.connected ? (
          <span
            className="block truncate font-mono text-xs text-muted-foreground/60"
            title={connector.prefixes[0]}
          >
            {connector.prefixes[0]}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <>
      {!connector.connected && connector.kind === "http" ? (
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
          {headerContent}
        </button>
      ) : (
        <div className="flex h-14 items-center gap-2.5 px-5">
          {headerContent}
        </div>
      )}
      <div
        className={`flex h-11 items-center justify-between gap-2 border-t border-border/50 pl-5 ${
          hasActions ? "pr-12" : "pr-2"
        }`}
      >
        {connector.kind === "mcp" ? (
          <span
            className="min-w-0 truncate font-mono text-xs text-muted-foreground/60"
            title={connector.endpoint}
          >
            {connector.endpoint}
          </span>
        ) : connector.connected ? (
          <span className="flex shrink-0 items-center gap-2 truncate text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            {t(($) => {
              return $.connectors.custom.statusConnected;
            })}
          </span>
        ) : connector.kind === "http" ? (
          <span className="flex shrink-0 items-center gap-2 truncate text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            {t(($) => {
              return $.connectors.catalog.filters.notConnected;
            })}
          </span>
        ) : null}
        {connector.kind === "http" && connector.connected ? (
          <CustomConnectorAgentAccess
            connector={connector}
            onManageAccess={onManageAccess}
          />
        ) : null}
      </div>
    </>
  );
}

function CustomConnectorRow({
  connector,
  isAdmin,
  onConnect,
  onDisconnect,
  onEdit,
  onManageAccess,
  onDelete,
}: CustomConnectorRowProps) {
  const { t } = useTranslation();
  const adminCanDelete =
    isAdmin && connector.oauthConfig?.providerAdapter !== "feishu";
  const adminCanEdit =
    adminCanDelete && isHttpCustomConnectorResponse(connector);
  const hasActions = connector.connected || adminCanDelete;
  const directOAuth = connectsDirectlyWithOAuth(connector);
  const cardContent = (
    <CustomConnectorCardContent
      connector={connector}
      hasActions={hasActions}
      onConnect={onConnect}
      onManageAccess={onManageAccess}
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
              {connector.kind === "http" &&
                !connector.connected &&
                directOAuth && (
                  <DropdownMenuItem onClick={onConnect}>
                    {t(($) => {
                      return $.connectors.actions.connect;
                    })}
                  </DropdownMenuItem>
                )}
              {connector.kind === "http" &&
                !connector.connected &&
                !directOAuth && (
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

function CustomConnectorDialogs() {
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
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openAccess = useSet(openCustomConnectorAccessDialog$);
  const openConnect = useSet(openCustomConnectorConnectDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
  const connectOAuth2 = useSet(connectCustomConnectorOAuth2$);
  const disconnect = useSet(disconnectCustomConnector$);
  const signal = useGet(pageSignal$);

  const handleDisconnect = (connector: CustomConnectorResponse) => {
    detach(disconnect(connector.id, signal), Reason.DomCallback);
  };

  const handleConnect = (connector: CustomConnectorHttpResponse) => {
    if (connectsDirectlyWithOAuth(connector)) {
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
                isAdmin={isAdmin}
                onConnect={() => {
                  if (isHttpCustomConnectorResponse(c)) {
                    return handleConnect(c);
                  }
                }}
                onDisconnect={() => {
                  return handleDisconnect(c);
                }}
                onEdit={() => {
                  if (isHttpCustomConnectorResponse(c)) {
                    return openEdit(c);
                  }
                }}
                onManageAccess={() => {
                  if (isHttpCustomConnectorResponse(c)) {
                    return openAccess(c);
                  }
                }}
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
