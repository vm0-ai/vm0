import type { FormEvent, ReactNode } from "react";
import { useGet, useLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { EllipsisVertical } from "lucide-react";
import type {
  ConnectorAccountConnection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@okouai/ui";

import { connectorAccountEffectiveLabel } from "../../../../signals/connector-domain.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  deleteConnectorAccount$,
  renameConnectorAccount$,
  setDefaultConnectorAccount$,
  settingsConnectorAccounts,
  type ConnectorAccountList,
} from "../../../../signals/okou-page/settings/connector-accounts.ts";
import {
  clearConnectorAccountDeletion$,
  clearConnectorAccountRename$,
  connectorAccountDeletionDraft$,
  connectorAccountRenameDraft$,
  prepareConnectorAccountDeletion$,
  resetConnectorAccountManagerDrafts$,
  setConnectorAccountRenameValue$,
  startConnectorAccountRename$,
} from "../../../../signals/okou-page/settings/connector-account-dialogs.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

interface ConnectorAccountManagerDialogProps {
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
  readonly icon: ReactNode;
  readonly onClose: () => void;
  readonly onAdd: () => void;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}

function accountIdentity(account: ConnectorAccountConnection): string | null {
  return (
    account.externalEmail ??
    account.externalUsername ??
    account.externalId ??
    null
  );
}

function AccountStatus({ account }: { account: ConnectorAccountConnection }) {
  const { t } = useTranslation();
  return account.connectionStatus === "reconnect-required" ? (
    <span className="text-amber-600">
      {t(($) => {
        return $.connectors.accounts.reconnectRequired;
      })}
    </span>
  ) : (
    <span className="text-muted-foreground">
      {t(($) => {
        return $.connectors.accounts.connected;
      })}
    </span>
  );
}

function AccountActions({
  target,
  account,
  onReconnect,
}: {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  const { t } = useTranslation();
  const startRename = useSet(startConnectorAccountRename$);
  const [, setDefault] = useLoadableSet(setDefaultConnectorAccount$);
  const [, prepareDelete] = useLoadableSet(prepareConnectorAccountDeletion$);
  const signal = useGet(pageSignal$);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t(($) => {
            return $.connectors.accounts.actions;
          })}
        >
          <EllipsisVertical size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            return onReconnect(account);
          }}
        >
          {t(($) => {
            return $.connectors.actions.reconnect;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            return startRename(account);
          }}
        >
          {t(($) => {
            return $.connectors.accounts.rename;
          })}
        </DropdownMenuItem>
        {!account.isDefault ? (
          <DropdownMenuItem
            onClick={() => {
              detach(
                setDefault({ target, connectionId: account.id }, signal),
                Reason.DomCallback,
              );
            }}
          >
            {t(($) => {
              return $.connectors.accounts.makeDefault;
            })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            detach(
              prepareDelete({ target, account }, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.connectors.actions.delete;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountRow({
  target,
  account,
  connectorLabel,
  onReconnect,
}: {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
  readonly connectorLabel: string;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  const { t } = useTranslation();
  const identity = accountIdentity(account);
  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {connectorAccountEffectiveLabel(account, connectorLabel)}
          </span>
          {account.isDefault ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
              {t(($) => {
                return $.connectors.accounts.default;
              })}
            </span>
          ) : null}
        </div>
        <div className="flex gap-2 truncate text-xs">
          <AccountStatus account={account} />
          {identity ? (
            <span className="truncate text-muted-foreground">{identity}</span>
          ) : null}
        </div>
      </div>
      <AccountActions
        target={target}
        account={account}
        onReconnect={onReconnect}
      />
    </div>
  );
}

function AccountList({
  loadable,
  target,
  connectorLabel,
  onReconnect,
}: {
  readonly loadable: Loadable<ConnectorAccountList>;
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  const { t } = useTranslation();
  if (loadable.state === "hasError") {
    return t(($) => {
      return $.connectors.accounts.accountsUnavailable;
    });
  }
  if (loadable.state === "loading") {
    return t(($) => {
      return $.connectors.accounts.loading;
    });
  }
  if (loadable.data.connections.length === 0) {
    return t(($) => {
      return $.connectors.accounts.noAccountsFound;
    });
  }
  return loadable.data.connections.map((account) => {
    return (
      <AccountRow
        key={account.id}
        target={target}
        account={account}
        connectorLabel={connectorLabel}
        onReconnect={onReconnect}
      />
    );
  });
}

function RenameAccountForm({ target }: { target: ConnectorAccountTarget }) {
  const { t } = useTranslation();
  const draft = useGet(connectorAccountRenameDraft$);
  const setValue = useSet(setConnectorAccountRenameValue$);
  const clear = useSet(clearConnectorAccountRename$);
  const [, rename] = useLoadableSet(renameConnectorAccount$);
  const signal = useGet(pageSignal$);
  if (!draft) {
    return null;
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const displayName = draft.displayName.trim();
    if (!displayName) {
      return;
    }
    detach(
      (async () => {
        await rename(
          { target, connectionId: draft.account.id, displayName },
          signal,
        );
        clear();
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <form className="rounded-lg border border-border p-3" onSubmit={submit}>
      <label className="text-sm font-medium" htmlFor="account-rename">
        {t(($) => {
          return $.connectors.accounts.accountName;
        })}
      </label>
      <div className="mt-2 flex gap-2">
        <Input
          id="account-rename"
          value={draft.displayName}
          onChange={(event) => {
            return setValue(event.target.value);
          }}
          maxLength={255}
        />
        <Button type="submit" disabled={!draft.displayName.trim()}>
          {t(($) => {
            return $.connectors.actions.save;
          })}
        </Button>
        <Button type="button" variant="outline" onClick={clear}>
          {t(($) => {
            return $.connectors.actions.cancel;
          })}
        </Button>
      </div>
    </form>
  );
}

function DeleteAccountConfirmation({
  target,
  connectorLabel,
}: {
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
}) {
  const { t } = useTranslation();
  const draft = useGet(connectorAccountDeletionDraft$);
  const clear = useSet(clearConnectorAccountDeletion$);
  const [deleteLoadable, deleteAccount] = useLoadableSet(
    deleteConnectorAccount$,
  );
  const signal = useGet(pageSignal$);
  if (!draft) {
    return null;
  }
  const remove = () => {
    detach(
      (async () => {
        await deleteAccount({ target, connectionId: draft.account.id }, signal);
        clear();
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <div className="rounded-lg border border-destructive/50 p-3">
      <p className="text-sm font-medium">
        {t(
          ($) => {
            return $.connectors.accounts.deleteTitle;
          },
          {
            account: connectorAccountEffectiveLabel(
              draft.account,
              connectorLabel,
            ),
          },
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {draft.explicitSelectionCount === 0
          ? t(($) => {
              return $.connectors.accounts.deleteDescription;
            })
          : t(
              ($) => {
                return $.connectors.accounts.deleteDescriptionWithCount;
              },
              { value: draft.explicitSelectionCount },
            )}
      </p>
      <DialogFooter className="mt-3">
        <Button type="button" variant="outline" onClick={clear}>
          {t(($) => {
            return $.connectors.actions.cancel;
          })}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={deleteLoadable.state === "loading"}
          onClick={remove}
        >
          {t(($) => {
            return $.connectors.accounts.deleteAccount;
          })}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ConnectorAccountManagerDialog({
  target,
  connectorLabel,
  icon,
  onClose,
  onAdd,
  onReconnect,
}: ConnectorAccountManagerDialogProps) {
  const { t } = useTranslation();
  const accountsLoadable = useLoadable(settingsConnectorAccounts.accounts$);
  const search = useGet(settingsConnectorAccounts.search$);
  const setSearch = useSet(settingsConnectorAccounts.setSearch$);
  const [loadMoreLoadable, loadMore] = useLoadableSet(
    settingsConnectorAccounts.loadMore$,
  );
  const resetDrafts = useSet(resetConnectorAccountManagerDrafts$);
  const signal = useGet(pageSignal$);
  const nextCursor =
    accountsLoadable.state === "hasData"
      ? accountsLoadable.data.nextCursor
      : null;
  const leave = (next: () => void) => {
    resetDrafts();
    next();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && leave(onClose);
      }}
    >
      <DialogContent className="max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            {icon}
            <DialogTitle>
              {t(
                ($) => {
                  return $.connectors.accounts.managerTitle;
                },
                { connector: connectorLabel },
              )}
            </DialogTitle>
          </div>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(event) => {
              return setSearch(event.target.value);
            }}
            placeholder={t(($) => {
              return $.connectors.accounts.find;
            })}
          />
          <Button
            type="button"
            onClick={() => {
              return leave(onAdd);
            }}
          >
            {t(($) => {
              return $.connectors.accounts.addAccount;
            })}
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-border p-4 text-sm text-muted-foreground">
          <AccountList
            loadable={accountsLoadable}
            target={target}
            connectorLabel={connectorLabel}
            onReconnect={(account) => {
              leave(() => {
                return onReconnect(account);
              });
            }}
          />
        </div>
        {nextCursor ? (
          <Button
            type="button"
            variant="outline"
            disabled={loadMoreLoadable.state === "loading"}
            onClick={() => {
              return detach(loadMore(signal), Reason.DomCallback);
            }}
          >
            {loadMoreLoadable.state === "loading"
              ? t(($) => {
                  return $.connectors.accounts.loadingMore;
                })
              : t(($) => {
                  return $.connectors.accounts.loadMore;
                })}
          </Button>
        ) : null}
        <RenameAccountForm target={target} />
        <DeleteAccountConfirmation
          target={target}
          connectorLabel={connectorLabel}
        />
      </DialogContent>
    </Dialog>
  );
}
