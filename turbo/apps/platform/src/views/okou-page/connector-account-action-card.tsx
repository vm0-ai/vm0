import {
  connectorAccountEffectiveLabel,
  connectorAccountExternalIdentity,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { Button } from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Check, CircleUserRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type {
  ConnectorAccountActionSignals,
  ConnectorAccountActionStatus,
} from "../../signals/chat-page/connector-account-action-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ConnectorAccountActionCard({
  signals,
}: {
  readonly signals: ConnectorAccountActionSignals;
}) {
  const loadable = useLoadable(signals.status$);
  const last = useLastLoadable(signals.status$);
  if (loadable.state === "loading" && last.state !== "hasData") {
    return <ConnectorAccountActionCardLoading />;
  }
  if (loadable.state === "hasError" && last.state !== "hasData") {
    return <ConnectorAccountActionCardError signals={signals} />;
  }
  const status =
    loadable.state === "hasData"
      ? loadable.data
      : last.state === "hasData"
        ? last.data
        : null;
  return status ? (
    <LoadedConnectorAccountActionCard signals={signals} status={status} />
  ) : null;
}

function ConnectorAccountActionCardLoading() {
  return (
    <div
      data-testid="connector-account-action-card-loading"
      className="flex min-h-[104px] w-full items-center justify-center rounded-lg border border-border/70 bg-background/85 p-3 shadow-sm"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function ConnectorAccountActionCardError({
  signals,
}: {
  readonly signals: ConnectorAccountActionSignals;
}) {
  const refresh = useSet(signals.refresh$);
  const { t } = useTranslation();
  return (
    <div
      data-testid="connector-account-action-card-error"
      className="flex min-h-[104px] w-full items-center gap-3 rounded-lg border border-border/70 bg-background/85 p-3 shadow-sm"
    >
      <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.connectorAccountSwitch.loadFailed;
        })}
      </div>
      <Button size="sm" variant="outline" onClick={refresh}>
        {t(($) => {
          return $.chat.connectorAccountSwitch.retry;
        })}
      </Button>
    </div>
  );
}

function LoadedConnectorAccountActionCard({
  signals,
  status,
}: {
  readonly signals: ConnectorAccountActionSignals;
  readonly status: ConnectorAccountActionStatus;
}) {
  if (status.kind === "unavailable") {
    return <UnavailableConnectorAccountActionCard />;
  }
  return <ReadyConnectorAccountActionCard signals={signals} status={status} />;
}

function UnavailableConnectorAccountActionCard() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="connector-account-action-card-unavailable"
      className="flex min-h-[104px] w-full items-center gap-3 rounded-lg border border-border/70 bg-background/85 p-3 shadow-sm"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
        <AlertCircle size={22} />
      </div>
      <div className="min-w-0">
        <div className="text-[0.9375rem] font-medium text-foreground">
          {t(($) => {
            return $.chat.connectorAccountSwitch.unavailableTitle;
          })}
        </div>
        <div className="mt-0.5 text-sm leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.connectorAccountSwitch.unavailableDescription;
          })}
        </div>
      </div>
    </div>
  );
}

function accountTargetLabel(
  account: ConnectorAccountConnection,
  customConnectorLabel: string,
): string {
  return account.target.kind === "builtin"
    ? account.target.connectorSlug
    : `${customConnectorLabel} · ${account.target.customConnectorId.slice(0, 8)}`;
}

function ReadyConnectorAccountActionCard({
  signals,
  status,
}: {
  readonly signals: ConnectorAccountActionSignals;
  readonly status: Extract<ConnectorAccountActionStatus, { kind: "ready" }>;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const confirmationState = useGet(signals.confirmationState$);
  const [, confirm] = useLoadableSet(signals.confirm$);
  const selected = status.selected;
  const switching = confirmationState === "loading";
  const switchFailed = confirmationState === "error" && !selected;
  const accountLabel = connectorAccountEffectiveLabel(
    status.account,
    t(($) => {
      return $.chat.connectorAccountSwitch.accountFallback;
    }),
  );
  const identity = connectorAccountExternalIdentity(status.account);
  const customConnectorLabel = t(($) => {
    return $.chat.connectorAccountSwitch.customConnector;
  });
  const target = accountTargetLabel(status.account, customConnectorLabel);

  return (
    <div
      data-testid="connector-account-action-card"
      className="w-full rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
          <CircleUserRound size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-[0.9375rem] font-medium text-foreground">
            {selected ? (
              <Check
                size={15}
                className="shrink-0 text-emerald-600 dark:text-emerald-400"
              />
            ) : null}
            {selected
              ? t(
                  ($) => {
                    return $.chat.connectorAccountSwitch.selected;
                  },
                  { account: accountLabel },
                )
              : t(
                  ($) => {
                    return $.chat.connectorAccountSwitch.title;
                  },
                  { account: accountLabel },
                )}
          </div>
          <div className="mt-0.5 truncate text-sm text-muted-foreground">
            {[target, identity && identity !== accountLabel ? identity : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {status.account.connectionStatus === "reconnect-required" ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.connectorAccountSwitch.reconnectRequired;
              })}
            </div>
          ) : null}
          {switchFailed ? (
            <div className="mt-1 text-xs text-destructive">
              {t(($) => {
                return $.chat.connectorAccountSwitch.actionFailed;
              })}
            </div>
          ) : null}
        </div>
        {selected ? null : (
          <Button
            size="sm"
            disabled={switching}
            onClick={() => {
              detach(confirm(pageSignal), Reason.DomCallback);
            }}
          >
            {switching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {switching
              ? t(($) => {
                  return $.chat.connectorAccountSwitch.switching;
                })
              : switchFailed
                ? t(($) => {
                    return $.chat.connectorAccountSwitch.retry;
                  })
                : t(($) => {
                    return $.chat.connectorAccountSwitch.switch;
                  })}
          </Button>
        )}
      </div>
    </div>
  );
}
