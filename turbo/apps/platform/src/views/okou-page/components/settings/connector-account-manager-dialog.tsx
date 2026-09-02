import type { FormEvent, ReactNode } from "react";
import { useGet, useLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { EllipsisVertical } from "lucide-react";
import {
  connectorAccountExternalIdentity,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  Button,
  cn,
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
  Radio,
  RadioGroup,
} from "@okouai/ui";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
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
import { useConnectorAccountLabel } from "./use-connector-account-label.ts";

interface ConnectorAccountManagerDialogProps {
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
  readonly icon: ReactNode;
  readonly connectionActionsEnabled: boolean;
  readonly onClose: () => void;
  readonly onAdd: () => void;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}

// Mirrors the status dot used by ConnectorAccountSummaryText on the connector
// card, so a row reads the same in the dialog as it does in the grid behind it.
function AccountStatus({ account }: { account: ConnectorAccountConnection }) {
  const { t } = useTranslation();
  const needsReconnect = account.connectionStatus === "reconnect-required";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          needsReconnect ? "bg-amber-500" : "bg-emerald-500",
        )}
      />
      <span
        className={cn(
          "truncate",
          needsReconnect
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
        )}
      >
        {needsReconnect
          ? t(($) => {
              return $.connectors.accounts.reconnectRequired;
            })
          : t(($) => {
              return $.connectors.accounts.connected;
            })}
      </span>
    </span>
  );
}

function AccountDefaultRadio({
  target,
  account,
}: {
  readonly target: ConnectorAccountTarget;
  readonly account: ConnectorAccountConnection;
}) {
  const { t } = useTranslation();
  const [setDefaultLoadable, setDefault] = useLoadableSet(
    setDefaultConnectorAccount$,
  );
  const signal = useGet(pageSignal$);
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2">
      {account.isDefault ? (
        <span className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t(($) => {
            return $.connectors.accounts.default;
          })}
        </span>
      ) : null}
      <Radio
        value={account.id}
        aria-label={
          account.isDefault
            ? t(($) => {
                return $.connectors.accounts.default;
              })
            : t(($) => {
                return $.connectors.accounts.makeDefault;
              })
        }
        disabled={setDefaultLoadable.state === "loading"}
        onClick={() => {
          if (account.isDefault) {
            return;
          }
          detach(
            setDefault({ target, connectionId: account.id }, signal),
            Reason.DomCallback,
          );
        }}
      />
    </label>
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
        {connectionActionsEnabled &&
        account.connectionStatus !== "reconnect-required" ? (
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
  const renameDraft = useGet(connectorAccountRenameDraft$);
  const accountLabel = useConnectorAccountLabel();
  const identity = connectorAccountExternalIdentity(account);
  const label = accountLabel(account);
  const needsReconnect = account.connectionStatus === "reconnect-required";
  if (renameDraft?.account.id === account.id) {
    return <RenameAccountForm target={target} />;
  }
  return (
    <div
      data-account-row
      className="flex items-center justify-between gap-4 px-5 py-4"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
          <AccountStatus account={account} />
          {identity && identity !== label ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{identity}</span>
            </>
          ) : null}
          {needsReconnect && connectionActionsEnabled ? (
            <>
              <span aria-hidden="true">·</span>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-[13px]"
                onClick={() => {
                  return onReconnect(account);
                }}
              >
                {t(($) => {
                  return $.connectors.actions.reconnect;
                })}
              </Button>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <AccountDefaultRadio target={target} account={account} />
        <AccountActions
          target={target}
          account={account}
          connectionActionsEnabled={connectionActionsEnabled}
          onReconnect={onReconnect}
        />
      </div>
    </div>
  );
}

function AccountsCard({
  loadable,
  target,
  connectionActionsEnabled,
  onReconnect,
}: {
  readonly loadable: Loadable<ConnectorAccountList>;
  readonly target: ConnectorAccountTarget;
  readonly connectionActionsEnabled: boolean;
  readonly onReconnect: (account: ConnectorAccountConnection) => void;
}) {
  if (loadable.state === "hasError") {
    return <AccountsMessage messageKey="accountsUnavailable" />;
  }
  if (loadable.state === "loading") {
    return <AccountsMessage messageKey="loading" />;
  }
  if (!loadable.data.available) {
    return <AccountsMessage messageKey="accountsUnavailable" />;
  }
  if (loadable.data.connections.length === 0) {
    return <AccountsMessage messageKey="noAccountsFound" />;
  }
  const defaultConnection = loadable.data.connections.find((account) => {
    return account.isDefault;
  });
  return (
    <RadioGroup
      value={defaultConnection?.id ?? null}
      // The row radios post their own change; RadioGroup only owns grouping.
      className="overflow-hidden rounded-xl bg-card"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
    >
      {loadable.data.connections.map((account, index) => {
        return (
          <div key={account.id}>
            {index > 0 ? <div className="mx-5 h-0 zero-border-t" /> : null}
            <AccountRow
              target={target}
              account={account}
              connectionActionsEnabled={connectionActionsEnabled}
              onReconnect={onReconnect}
            />
          </div>
        );
      })}
    </RadioGroup>
  );
}

function AccountsMessage({
  messageKey,
}: {
  readonly messageKey: "accountsUnavailable" | "loading" | "noAccountsFound";
}) {
  const { t } = useTranslation();
  return (
    <p className="py-8 text-center text-sm text-muted-foreground">
      {messageKey === "accountsUnavailable"
        ? t(($) => {
            return $.connectors.accounts.accountsUnavailable;
          })
        : messageKey === "loading"
          ? t(($) => {
              return $.connectors.accounts.loading;
            })
          : t(($) => {
              return $.connectors.accounts.noAccountsFound;
            })}
    </p>
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
    <form className="px-1 py-4" onSubmit={submit}>
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
  const accountLabel = useConnectorAccountLabel();
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
              { account: accountLabel(draft.account) },
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
    <div className="relative">
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
      <DialogContent className="!flex w-full max-w-xl !flex-col !overflow-hidden">
        <DialogHeader className="shrink-0 gap-2">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              {icon}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {t(
                  ($) => {
                    return $.connectors.accounts.managerTitle;
                  },
                  { connector: connectorLabel },
                )}
              </DialogTitle>
              <DialogDescription>
                {t(($) => {
                  return $.connectors.accounts.managerDescription;
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {showSearch ? (
          <div className="shrink-0">
            <ConnectorAccountSearch value={search} />
          </div>
        ) : null}
        <div className="min-h-0 overflow-y-auto">
          <AccountsCard
            loadable={accountsLoadable}
            target={target}
            connectionActionsEnabled={connectionActionsEnabled}
            onReconnect={reconnect}
          />
          {nextCursor ? (
            <Button
              type="button"
              variant="outline"
              className="mt-3 w-full"
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
        </div>
        <DialogFooter className="shrink-0">
          <Button
            type="button"
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
        </DialogFooter>
        <DeleteAccountConfirmation target={target} />
      </DialogContent>
    </Dialog>
  );
}
