import { useGet, useLastResolved, useSet } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  clearCustomConnectorSecret$,
  customConnectorDialog$,
  customConnectors$,
  openCustomConnectorConnectDialog$,
  openCustomConnectorDeleteDialog$,
  openCustomConnectorRenameDialog$,
  setCustomConnectorRenameInput$,
} from "../../../../signals/zero-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { CustomConnectorIcon } from "./custom-connector-icon.tsx";
import { CustomConnectorCreateDialog } from "./custom-connector-create-dialog.tsx";
import { CustomConnectorRenameDialog } from "./custom-connector-rename-dialog.tsx";
import { CustomConnectorConnectDialog } from "./custom-connector-connect-dialog.tsx";
import { CustomConnectorDeleteConfirm } from "./custom-connector-delete-confirm.tsx";
import noConnectorImg from "../../assets/no-connector.webp";

function CustomConnectorRow({
  connector,
  isAdmin,
  onConnect,
  onDisconnect,
  onRename,
  onDelete,
}: {
  connector: CustomConnectorResponse;
  isAdmin: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const hasActions = connector.hasSecret || isAdmin;

  return (
    <div className="zero-card flex flex-col">
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
      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex items-center gap-2 min-w-0">
          {connector.hasSecret ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
              Connected
            </span>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Connect
            </button>
          )}
          {connector.prefixes[0] && (
            <span className="truncate text-xs text-muted-foreground/60 font-mono">
              {connector.prefixes[0]}
            </span>
          )}
        </div>
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                aria-label="More options"
              >
                <IconDotsVertical size={14} stroke={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {!connector.hasSecret && (
                <DropdownMenuItem onClick={onConnect}>Connect</DropdownMenuItem>
              )}
              {connector.hasSecret && (
                <DropdownMenuItem onClick={onDisconnect}>
                  Disconnect
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <>
                  <DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={onDelete}
                    className="text-destructive focus:text-destructive"
                  >
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

export function CustomConnectorsPanel() {
  const connectors = useLastResolved(customConnectors$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const dialog = useGet(customConnectorDialog$);
  const openRename = useSet(openCustomConnectorRenameDialog$);
  const openConnect = useSet(openCustomConnectorConnectDialog$);
  const openDelete = useSet(openCustomConnectorDeleteDialog$);
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

  return (
    <section className="flex flex-col gap-3">
      {connectors && connectors.length === 0 && (
        <div className="zero-card py-12 flex flex-col items-center gap-3">
          <img
            src={noConnectorImg}
            alt="No connectors"
            className="h-20 w-20 object-contain opacity-80"
          />
          <p className="text-sm text-muted-foreground text-center">
            {isAdmin
              ? "No custom connectors yet. Create one to register an API for every member to use."
              : "Your org hasn't registered any custom connectors yet."}
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
                  return openConnect(c);
                }}
                onDisconnect={() => {
                  return handleDisconnect(c);
                }}
                onRename={() => {
                  return handleRename(c);
                }}
                onDelete={() => {
                  return openDelete(c);
                }}
              />
            );
          })}
        </div>
      )}

      {dialog.kind === "create" && <CustomConnectorCreateDialog />}
      {dialog.kind === "rename" && (
        <CustomConnectorRenameDialog
          id={dialog.connector.id}
          currentDisplayName={dialog.connector.displayName}
        />
      )}
      {dialog.kind === "connect" && (
        <CustomConnectorConnectDialog
          id={dialog.connector.id}
          displayName={dialog.connector.displayName}
        />
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
