import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconDotsVertical,
  IconPlus,
  IconCheck,
  IconPlug,
} from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";
import type { CustomConnectorResponse } from "@vm0/core";
import {
  clearCustomConnectorSecret$,
  customConnectorDialog$,
  customConnectors$,
  openCustomConnectorConnectDialog$,
  openCustomConnectorCreateDialog$,
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
  return (
    <div className="zero-card flex flex-col">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={20}
        />
        <span className="truncate text-sm font-medium text-foreground">
          {connector.displayName}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {connector.hasSecret ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <IconCheck size={12} stroke={1.5} />
              Connected
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={onConnect}>
              <IconPlug size={14} stroke={1.5} className="mr-1" />
              Connect
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <IconDotsVertical size={14} stroke={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
        </div>
      </div>
      <div className="flex h-11 items-center border-t border-border/30 px-5 text-xs text-muted-foreground">
        <span className="truncate font-mono">{connector.prefixes[0]}</span>
      </div>
    </div>
  );
}

export function CustomConnectorsPanel() {
  const connectors = useLastResolved(customConnectors$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const dialog = useGet(customConnectorDialog$);
  const openCreate = useSet(openCustomConnectorCreateDialog$);
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
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          <span>Custom connectors</span>
          {connectors && <span> ({connectors.length})</span>}
        </h2>
        {isAdmin && (
          <Button size="sm" onClick={openCreate}>
            <IconPlus size={14} stroke={1.5} className="mr-1" />
            New
          </Button>
        )}
      </div>

      {connectors && connectors.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "No custom connectors yet. Create one to register an API for every member to use."
            : "Your org hasn't registered any custom connectors yet."}
        </p>
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
