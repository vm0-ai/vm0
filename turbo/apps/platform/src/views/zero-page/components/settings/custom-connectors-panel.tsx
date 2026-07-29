import { useGet, useLastResolved, useSet } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  clearCustomConnectorSecret$,
  connectCustomConnectorOAuth2$,
  customConnectorDialog$,
  customConnectors$,
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
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { noConnectorImg } from "../../platform-assets.ts";

function connectsDirectlyWithOAuth(
  connector: CustomConnectorResponse,
  oauth2Enabled: boolean,
): boolean {
  return oauth2Enabled && connector.authMode === "oauth";
}

function CustomConnectorRow({
  connector,
  isAdmin,
  onConnect,
  onDisconnect,
  onEdit,
  onRename,
  fullEditingEnabled,
  onDelete,
}: {
  connector: CustomConnectorResponse;
  isAdmin: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onRename: () => void;
  fullEditingEnabled: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const hasActions = connector.hasSecret || isAdmin;
  const directOAuth = connectsDirectlyWithOAuth(connector, fullEditingEnabled);
  const cardContent = (
    <>
      <div className="flex h-14 items-center gap-2.5 px-5">
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={20}
        />
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
          {connector.displayName}
        </span>
      </div>
      <div
        className={`flex h-11 items-center border-t border-border/50 pl-5 ${
          hasActions ? "pr-12" : "pr-5"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {connector.hasSecret && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
              {t(($) => {
                return $.connectors.custom.statusConnected;
              })}
            </span>
          )}
          {connector.prefixes[0] && (
            <span className="truncate text-xs text-muted-foreground/60 font-mono">
              {connector.prefixes[0]}
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="relative">
      {connector.hasSecret ? (
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
              {!connector.hasSecret && directOAuth && (
                <DropdownMenuItem onClick={onConnect}>
                  {t(($) => {
                    return $.connectors.actions.connect;
                  })}
                </DropdownMenuItem>
              )}
              {!connector.hasSecret && !directOAuth && (
                <DropdownMenuModalItem onModalSelect={onConnect}>
                  {t(($) => {
                    return $.connectors.actions.connect;
                  })}
                </DropdownMenuModalItem>
              )}
              {connector.hasSecret && (
                <DropdownMenuItem onClick={onDisconnect}>
                  {t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
                </DropdownMenuItem>
              )}
              {isAdmin && (
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

export function CustomConnectorsPanel() {
  const { t } = useTranslation();
  const connectors = useLastResolved(customConnectors$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const featureSwitches = useGet(featureSwitch$);
  const fullEditingEnabled =
    featureSwitches[FeatureSwitchKey.CustomConnectorOAuth2] ?? false;
  const dialog = useGet(customConnectorDialog$);
  const openEdit = useSet(openCustomConnectorEditDialog$);
  const openRename = useSet(openCustomConnectorRenameDialog$);
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
    if (connectsDirectlyWithOAuth(connector, fullEditingEnabled)) {
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
                fullEditingEnabled={fullEditingEnabled}
                onDelete={() => {
                  return openDelete(c);
                }}
              />
            );
          })}
        </div>
      )}

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
      {dialog.kind === "delete" && (
        <CustomConnectorDeleteConfirm
          id={dialog.connector.id}
          displayName={dialog.connector.displayName}
        />
      )}
    </section>
  );
}
