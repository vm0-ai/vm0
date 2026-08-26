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
  DialogDescription,
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
  connectorAccountSummaryByTarget$,
  connectorAccountTargetKey,
  CONNECTOR_ACCOUNT_SEARCH_THRESHOLD,
  type ConnectorAccountList,
} from "../../../../signals/okou-page/connector-accounts.ts";
import {
  deleteConnectorAccount$,
  renameConnectorAccount$,
  setDefaultConnectorAccount$,
  settingsConnectorAccounts,
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
  readonly connectionActionsEnabled: boolean;
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
  connectionActionsEnabled,
  onReconnect,
}: {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
  readonly connectionActionsEnabled: boolean;
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
          showTooltip
          type="button"
          variant="quiet"
          size="icon"
          aria-label={t(($) => {
            return $.connectors.accounts.actions;
          })}
        >
          <EllipsisVertical size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {connectionActionsEnabled ? (
          <DropdownMenuItem
            onClick={() => {
              return onReconnect(account);
            }}
          >
            {t(($) => {
              return $.connectors.actions.reconnect;
            })}
          </DropdownMenuItem>
        ) : null}
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
  connectionActionsEnabled,
  onReconnect,
}: {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
  readonly connectionActionsEnabled: boolean;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  const { t } = useTranslation();
  const identity = accountIdentity(account);
  const label = connectorAccountEffectiveLabel(
    account,
    t(
      ($) => {
        return $.connectors.accounts.fallbackName;
      },
      { id: account.id.slice(0, 8) },
    ),
  );
  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {label}
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
          {identity && identity !== label ? (
            <span className="truncate text-muted-foreground">{identity}</span>
          ) : null}
        </div>
      </div>
      <AccountActions
        target={target}
        account={account}
        connectionActionsEnabled={connectionActionsEnabled}
        onReconnect={onReconnect}
      />
    </div>
  );
}

function AccountList({
  loadable,
  defaultConnectionId,
  target,
  connectionActionsEnabled,
  onReconnect,
}: {
  readonly loadable: Loadable<ConnectorAccountList>;
  readonly defaultConnectionId: string | null;
  readonly target: ConnectorAccountTarget;
  readonly connectionActionsEnabled: boolean;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  const { t } = useTranslation();
  const renameDraft = useGet(connectorAccountRenameDraft$);
  if (loadable.state === "hasError") {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.accounts.accountsUnavailable;
        })}
      </p>
    );
  }
  if (loadable.state === "loading") {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.accounts.loading;
        })}
      </p>
    );
  }
  if (!loadable.data.available) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.accounts.accountsUnavailable;
        })}
      </p>
    );
  }
  if (loadable.data.connections.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.accounts.noAccountsFound;
        })}
      </p>
    );
  }
  return loadable.data.connections
    .filter((account) => {
      return account.id !== defaultConnectionId;
    })
    .flatMap((account) => {
      return [
        <AccountRow
          key={`${account.id}-row`}
          target={target}
          account={account}
          connectionActionsEnabled={connectionActionsEnabled}
          onReconnect={onReconnect}
        />,
        renameDraft?.account.id === account.id ? (
          <RenameAccountForm key={`${account.id}-rename`} target={target} />
        ) : null,
      ];
    });
}

function DefaultAccount({
  target,
  account,
  connectionActionsEnabled,
  onReconnect,
}: {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
  readonly connectionActionsEnabled: boolean;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  const { t } = useTranslation();
  const renameDraft = useGet(connectorAccountRenameDraft$);
  return (
    <div
      role="group"
      aria-label={t(($) => {
        return $.connectors.accounts.default;
      })}
      className="border-b border-border bg-muted/20 text-sm text-muted-foreground"
    >
      <AccountRow
        target={target}
        account={account}
        connectionActionsEnabled={connectionActionsEnabled}
        onReconnect={onReconnect}
      />
      {renameDraft?.account.id === account.id ? (
        <RenameAccountForm target={target} />
      ) : null}
    </div>
  );
}

function RenameAccountForm({ target }: { target: ConnectorAccountTarget }) {
  const { t } = useTranslation();
  const draft = useGet(connectorAccountRenameDraft$);
  const setValue = useSet(setConnectorAccountRenameValue$);
  const clear = useSet(clearConnectorAccountRename$);
  const [renameLoadable, rename] = useLoadableSet(renameConnectorAccount$);
  const signal = useGet(pageSignal$);
  if (!draft) {
    return null;
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const displayName = draft.displayName.trim() || null;
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
    <form
      className="border-b border-border bg-muted/30 px-4 py-3"
      onSubmit={submit}
    >
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
        <Button type="submit" disabled={renameLoadable.state === "loading"}>
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
}: {
  readonly target: ConnectorAccountTarget;
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
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && clear();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="line-clamp-2 break-words pr-8 leading-snug">
            {t(
              ($) => {
                return $.connectors.accounts.deleteTitle;
              },
              {
                account: connectorAccountEffectiveLabel(
                  draft.account,
                  t(
                    ($) => {
                      return $.connectors.accounts.fallbackName;
                    },
                    { id: draft.account.id.slice(0, 8) },
                  ),
                ),
              },
            )}
          </DialogTitle>
          <DialogDescription>
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
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
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
      </DialogContent>
    </Dialog>
  );
}

function ConnectorAccountSearch({ value }: { readonly value: string }) {
  const { t } = useTranslation();
  const setSearch = useSet(settingsConnectorAccounts.setSearch$);
  const signal = useGet(pageSignal$);
  return (
    <div className="border-b border-border px-6 py-3">
      <Input
        value={value}
        onChange={(event) => {
          return setSearch(event.target.value, signal);
        }}
        placeholder={t(($) => {
          return $.connectors.accounts.find;
        })}
      />
    </div>
  );
}

function connectorAccountSearchIsVisible(
  search: string,
  accounts: Loadable<ConnectorAccountList>,
): boolean {
  if (search.length > 0) {
    return true;
  }
  return (
    accounts.state === "hasData" &&
    (accounts.data.connections.length > CONNECTOR_ACCOUNT_SEARCH_THRESHOLD ||
      accounts.data.nextCursor !== null)
  );
}

export function ConnectorAccountManagerDialog({
  target,
  connectorLabel,
  icon,
  connectionActionsEnabled,
  onClose,
  onAdd,
  onReconnect,
}: ConnectorAccountManagerDialogProps) {
  const { t } = useTranslation();
  const accountsLoadable = useLoadable(settingsConnectorAccounts.accounts$);
  const summariesLoadable = useLoadable(connectorAccountSummaryByTarget$);
  const search = useGet(settingsConnectorAccounts.search$);
  const [loadMoreLoadable, loadMore] = useLoadableSet(
    settingsConnectorAccounts.loadMore$,
  );
  const resetDrafts = useSet(resetConnectorAccountManagerDrafts$);
  const signal = useGet(pageSignal$);
  const nextCursor =
    accountsLoadable.state === "hasData"
      ? accountsLoadable.data.nextCursor
      : null;
  const defaultConnection =
    summariesLoadable.state === "hasData" &&
    accountsLoadable.state === "hasData" &&
    accountsLoadable.data.available
      ? (summariesLoadable.data.get(connectorAccountTargetKey(target))
          ?.defaultConnection ?? null)
      : null;
  const showSearch = connectorAccountSearchIsVisible(search, accountsLoadable);
  const leave = (next: () => void) => {
    resetDrafts();
    next();
  };
  const reconnect = (account: ConnectorAccountConnection) => {
    leave(() => {
      return onReconnect(account);
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && leave(onClose);
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b border-border bg-muted/40 py-4 pl-6 pr-16">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              {icon}
              <DialogTitle className="truncate leading-6">
                {connectorLabel}
              </DialogTitle>
            </div>
            <Button
              type="button"
              className="shrink-0"
              disabled={
                !connectionActionsEnabled ||
                accountsLoadable.state === "hasError" ||
                (accountsLoadable.state === "hasData" &&
                  !accountsLoadable.data.available)
              }
              onClick={() => {
                return leave(onAdd);
              }}
            >
              {t(($) => {
                return $.connectors.accounts.addAccount;
              })}
            </Button>
          </div>
        </DialogHeader>
        {showSearch ? <ConnectorAccountSearch value={search} /> : null}
        {defaultConnection ? (
          <DefaultAccount
            target={target}
            account={defaultConnection}
            connectionActionsEnabled={connectionActionsEnabled}
            onReconnect={reconnect}
          />
        ) : null}
        <div className="max-h-[min(60vh,420px)] overflow-y-auto text-sm text-muted-foreground">
          <AccountList
            loadable={accountsLoadable}
            defaultConnectionId={defaultConnection?.id ?? null}
            target={target}
            connectionActionsEnabled={connectionActionsEnabled}
            onReconnect={reconnect}
          />
        </div>
        {nextCursor ? (
          <div className="border-t border-border px-6 py-3">
            <Button
              type="button"
              variant="outline"
              className="w-full"
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
          </div>
        ) : null}
        <DeleteAccountConfirmation target={target} />
      </DialogContent>
    </Dialog>
  );
}
