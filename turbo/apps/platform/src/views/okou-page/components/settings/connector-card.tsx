import type { ReactNode } from "react";
import type { LoadableState } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { CircleCheck, EllipsisVertical, Loader2, Plus } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorAccountEffectiveLabel,
  type ConnectorAccountSummary,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { PlatformConnectorCatalogStatusItem } from "../../../../signals/connector-domain.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@okouai/ui";
import {
  connectorCurrentConnectionStatus,
  connectorExpiryCountdownText,
} from "../../../../signals/okou-page/settings/connectors.ts";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { ConnectorPermissionRow } from "./connector-permission-row.tsx";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./launch-connector-connect.ts";

type CatalogConnectorCardProps = {
  readonly variant: "catalog";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
};

type ConnectionConnectorCardProps = {
  readonly variant: "connection";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly disconnecting: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly manageAccess?: ReactNode;
  readonly onDisconnect: () => void;
  readonly onReviewScopes?: () => void;
};

export type ConnectorAccountSummaryStatus = "loading" | "unavailable" | "ready";

export function connectorAccountSummaryStatus(
  state: LoadableState,
): ConnectorAccountSummaryStatus {
  if (state === "hasData") {
    return "ready";
  }
  if (state === "hasError") {
    return "unavailable";
  }
  return "loading";
}

type AccountsConnectorCardProps = {
  readonly variant: "accounts";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly summary: ConnectorAccountSummary | undefined;
  readonly summaryStatus: ConnectorAccountSummaryStatus;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly manageAccess?: ReactNode;
  readonly onManage: () => void;
};

type OnboardingConnectorCardProps = {
  readonly variant: "onboarding";
  readonly connectorSlug: ConnectorSlug;
  readonly connector: PlatformConnectorCatalogStatusItem | undefined;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly layout: "workflow" | "prompt";
  readonly required: boolean;
  readonly connect: ConnectorConnectHandlers | undefined;
};

type ActionConnectorCardProps = {
  readonly variant: "action";
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  readonly connected: boolean;
  readonly complete: boolean;
  readonly reconnectRequired: boolean;
  readonly busy: boolean;
  readonly className?: string;
  readonly onActivate: () => void;
};

type PermissionConnectorCardProps = {
  readonly variant: "permission";
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly showManage: boolean;
  readonly isLast: boolean;
  readonly onManage: () => void;
  readonly onToggle: (checked: boolean) => void;
};

type ConnectorCardProps =
  | CatalogConnectorCardProps
  | ConnectionConnectorCardProps
  | AccountsConnectorCardProps
  | OnboardingConnectorCardProps
  | ActionConnectorCardProps
  | PermissionConnectorCardProps;

function runConnect(
  connector: PlatformConnectorCatalogStatusItem,
  connect: ConnectorConnectHandlers,
  busy: boolean,
): void {
  if (busy) {
    return;
  }
  launchConnectorConnect({ connector, ...connect });
}

function CatalogConnectorCard({
  connector,
  busy,
  connect,
}: CatalogConnectorCardProps) {
  const { t } = useTranslation();
  const handleConnect = () => {
    runConnect(connector, connect, busy);
  };

  return (
    <div
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-label={t(
        ($) => {
          return $.connectors.card.connectAria;
        },
        { connector: connector.label },
      )}
      aria-disabled={busy}
      className={cn(
        "zero-card overflow-hidden text-left",
        busy ? "cursor-default" : "cursor-pointer",
      )}
      onClick={handleConnect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleConnect();
        }
      }}
    >
      <div className="flex items-center gap-2.5 px-5 pb-1 pt-4">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ConnectorIcon icon={connector.icon} size={20} />
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {connector.label}
        </span>
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            !busy && "border border-border/60",
          )}
          aria-hidden="true"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={14} />
          )}
        </span>
      </div>
      <div className="px-5 pb-4 pt-1">
        <div
          data-testid="connector-help-text"
          className="line-clamp-2 text-xs text-muted-foreground"
        >
          {connector.description}
        </div>
      </div>
    </div>
  );
}

function ConnectorConnectionStatus({
  connector,
  connected,
  busy,
  connect,
}: {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
}) {
  const { t } = useTranslation();
  const connectionStatus = connectorCurrentConnectionStatus(connector);
  if (busy) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        {t(($) => {
          return $.connectors.card.connecting;
        })}
      </span>
    );
  }
  if (connected && connectionStatus === "reconnect-required") {
    return (
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="text-amber-600 dark:text-amber-400">
          {t(($) => {
            return $.connectors.card.connectionExpired;
          })}
        </span>
      </span>
    );
  }
  if (connected && connectionStatus === "scope-mismatch") {
    return (
      <span className="flex min-w-0 items-center gap-2 text-[11px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="min-w-0 truncate text-amber-600 dark:text-amber-400">
          {t(($) => {
            return $.connectors.card.updatePermissions;
          })}
        </span>
      </span>
    );
  }
  if (connected) {
    const expiryText = connectorExpiryCountdownText(connector);
    const connectedText =
      expiryText ??
      (connector.connection?.externalUsername
        ? `@${connector.connection.externalUsername}`
        : t(($) => {
            return $.connectors.card.connected;
          }));
    return (
      <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="min-w-0 truncate" title={connectedText}>
          {connectedText}
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        runConnect(connector, connect, busy);
      }}
      className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {t(($) => {
        return $.connectors.actions.connect;
      })}
    </button>
  );
}

function ConnectionConnectorCard({
  connector,
  connected,
  busy,
  disconnecting,
  connect,
  manageAccess,
  onDisconnect,
  onReviewScopes,
}: ConnectionConnectorCardProps) {
  const { t } = useTranslation();
  const connectionStatus = connectorCurrentConnectionStatus(connector);
  return (
    <div className="zero-card flex flex-col">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ConnectorIcon icon={connector.icon} size={20} />
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {connector.label}
        </span>
      </div>
      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <ConnectorConnectionStatus
            connector={connector}
            connected={connected}
            busy={busy}
            connect={connect}
          />
        </div>
        {connected ? (
          <div className="flex min-w-0 flex-1 items-center justify-end gap-0">
            {manageAccess}
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
                  disabled={busy}
                >
                  <EllipsisVertical size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {connectionStatus === "reconnect-required" ? (
                  <DropdownMenuModalItem
                    onModalSelect={() => {
                      runConnect(connector, connect, busy);
                    }}
                  >
                    {t(($) => {
                      return $.connectors.actions.reconnect;
                    })}
                  </DropdownMenuModalItem>
                ) : null}
                {connectionStatus === "scope-mismatch" && onReviewScopes ? (
                  <DropdownMenuModalItem onModalSelect={onReviewScopes}>
                    {t(($) => {
                      return $.connectors.card.reviewPermissions;
                    })}
                  </DropdownMenuModalItem>
                ) : null}
                <DropdownMenuItem
                  onClick={onDisconnect}
                  disabled={disconnecting || busy}
                >
                  {t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ConnectorAccountSummaryText({
  summary,
  status,
  className,
}: {
  readonly summary: ConnectorAccountSummary | undefined;
  readonly status: ConnectorAccountSummaryStatus;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  if (status === "loading") {
    return (
      <span className={className}>
        {t(($) => {
          return $.connectors.accounts.loading;
        })}
      </span>
    );
  }
  if (status === "unavailable") {
    return (
      <span className={cn("flex min-w-0 items-center gap-2", className)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="min-w-0 truncate text-amber-600 dark:text-amber-400">
          {t(($) => {
            return $.connectors.accounts.accountsUnavailable;
          })}
        </span>
      </span>
    );
  }
  const accountCount = summary?.accountCount ?? 0;
  let summaryText = (() => {
    if (accountCount === 0) {
      return t(($) => {
        return $.connectors.accounts.noAccounts;
      });
    }
    if (accountCount === 1) {
      if (summary?.defaultConnection) {
        return connectorAccountEffectiveLabel(
          summary.defaultConnection,
          t(
            ($) => {
              return $.connectors.accounts.fallbackName;
            },
            { id: summary.defaultConnection.id.slice(0, 8) },
          ),
        );
      }
      return t(
        ($) => {
          return $.connectors.accounts.summaryOne;
        },
        { value: accountCount },
      );
    }
    return t(
      ($) => {
        return $.connectors.accounts.summaryMany;
      },
      { value: accountCount },
    );
  })();
  if (summary && summary.attentionCount > 0) {
    summaryText = t(
      ($) => {
        return $.connectors.accounts.summaryWithAttention;
      },
      { total: accountCount, value: summary.attentionCount },
    );
  }
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          accountCount === 0 && "bg-muted-foreground/50",
          accountCount > 0 && summary?.attentionCount === 0 && "bg-emerald-500",
          accountCount > 0 &&
            summary !== undefined &&
            summary.attentionCount > 0 &&
            "bg-amber-500",
        )}
      />
      <span
        className={cn(
          "min-w-0 truncate",
          summary !== undefined &&
            summary.attentionCount > 0 &&
            "text-amber-600 dark:text-amber-400",
        )}
        title={summaryText}
      >
        {summaryText}
      </span>
    </span>
  );
}

function AccountsConnectorCard({
  connector,
  summary,
  summaryStatus,
  busy,
  connect,
  manageAccess,
  onManage,
}: AccountsConnectorCardProps) {
  const { t } = useTranslation();
  const accountCount = summary?.accountCount ?? 0;
  const showDescription = summaryStatus === "ready" && accountCount === 0;
  const canManage = summaryStatus === "ready" && accountCount > 0;
  const canConnect = summaryStatus === "ready" && accountCount === 0;
  const canActivate = !busy && (canManage || canConnect);
  const activate = () => {
    if (!canActivate) {
      return;
    }
    if (canManage) {
      onManage();
      return;
    }
    if (canConnect) {
      runConnect(connector, connect, busy);
    }
  };
  return (
    <div
      className={cn(
        "zero-card relative flex flex-col text-left",
        showDescription && "overflow-hidden",
        canActivate && "cursor-pointer",
      )}
    >
      {canManage || canConnect ? (
        <button
          type="button"
          aria-label={
            canManage
              ? t(
                  ($) => {
                    return $.connectors.accounts.managerTitle;
                  },
                  { connector: connector.label },
                )
              : t(
                  ($) => {
                    return $.connectors.card.connectAria;
                  },
                  { connector: connector.label },
                )
          }
          className={cn(
            "absolute inset-0 z-10 rounded-[inherit] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            busy ? "cursor-default" : "cursor-pointer",
          )}
          disabled={busy}
          onClick={activate}
        />
      ) : null}
      <div
        className={cn(
          "flex items-center gap-2.5 px-5",
          showDescription ? "pb-1 pt-4" : "h-14",
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ConnectorIcon icon={connector.icon} size={20} />
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {connector.label}
        </span>
        {accountCount === 0 && summaryStatus === "ready" ? (
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              !busy && "border border-border/60",
            )}
            aria-hidden="true"
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
          </span>
        ) : null}
      </div>
      {showDescription ? (
        <div className="px-5 pb-4 pt-1">
          <div
            data-testid="connector-help-text"
            className="line-clamp-2 text-xs text-muted-foreground"
          >
            {connector.description}
          </div>
        </div>
      ) : (
        <div className="flex h-11 items-center gap-2 border-t border-border/50 pl-5 pr-2">
          <ConnectorAccountSummaryText
            summary={summary}
            status={summaryStatus}
            className="min-w-0 flex-1 text-xs text-muted-foreground"
          />
          <div className="relative z-20 min-w-0 max-w-full">{manageAccess}</div>
        </div>
      )}
    </div>
  );
}

function onboardingHelpText(
  helpText: string | undefined,
  fallback: string,
): string {
  return (helpText ?? fallback)
    .replace(/^Connect your \w+ account to /u, "")
    .replace(/^Connect your Google account to /u, "")
    .replace(/^Connect /u, "");
}

function OnboardingConnectorCard({
  connectorSlug,
  connector,
  connected,
  busy,
  loading,
  layout,
  required,
  connect,
}: OnboardingConnectorCardProps) {
  const { t } = useTranslation();
  const label = connector?.label ?? connectorSlug;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3",
        layout === "workflow"
          ? "border-b border-border/40 py-[18px] last:border-b-0"
          : "rounded-xl border border-border px-4 py-3.5 sm:px-5 sm:py-4",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
        <ConnectorIcon icon={connector?.icon} size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          data-testid="connector-card-label"
          className="truncate text-sm font-medium"
        >
          {label}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {layout === "workflow" ? (
            <span className="text-muted-foreground/70">
              {required
                ? t(($) => {
                    return $.connectors.card.required;
                  })
                : t(($) => {
                    return $.connectors.card.optional;
                  })}{" "}
              ·{" "}
            </span>
          ) : null}
          {onboardingHelpText(
            connector?.description,
            t(($) => {
              return $.connectors.card.connectToContinue;
            }),
          )}
        </p>
      </div>
      {connected ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary">
          <CircleCheck size={16} aria-hidden="true" />
          {t(($) => {
            return $.connectors.card.connected;
          })}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-[10px] px-4 text-sm"
          disabled={loading || !connector || !connect || busy}
          onClick={() => {
            if (connector && connect) {
              runConnect(connector, connect, busy);
            }
          }}
        >
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : null}
          {t(($) => {
            return $.connectors.actions.connect;
          })}
        </Button>
      )}
    </div>
  );
}

function ActionConnectorCard({
  icon,
  label,
  description,
  connected,
  complete,
  reconnectRequired,
  busy,
  className,
  onActivate,
}: ActionConnectorCardProps) {
  const { t } = useTranslation();
  const actionLabel = complete
    ? t(($) => {
        return $.connectors.card.authorized;
      })
    : reconnectRequired
      ? t(($) => {
          return $.connectors.actions.reconnect;
        })
      : connected
        ? t(($) => {
            return $.connectors.actions.authorize;
          })
        : t(($) => {
            return $.connectors.actions.connect;
          });

  return (
    <div
      data-testid="connector-action-card"
      className={cn(
        "zero-card flex min-h-[88px] w-full flex-col gap-3 p-3 text-left sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          {icon}
        </div>
        <div className="min-w-0">
          <div
            data-testid="connector-card-label"
            className="truncate text-[0.9375rem] font-medium text-foreground"
          >
            {label}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {description}
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={complete || busy}
        onClick={onActivate}
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : null}
        {actionLabel}
      </button>
    </div>
  );
}

function permissionDescription(description: string): string {
  return description
    .replace(/^Connect your \w+ account to /iu, "")
    .replace(/^access /iu, "")
    .replace(/^./u, (character) => {
      return character.toUpperCase();
    });
}

function PermissionConnectorCard({
  connector,
  enabled,
  loading,
  showManage,
  isLast,
  onManage,
  onToggle,
}: PermissionConnectorCardProps) {
  return (
    <ConnectorPermissionRow
      icon={<ConnectorIcon icon={connector.icon} size={20} />}
      label={connector.label}
      labelSuffix={
        connector.connection?.externalUsername ? (
          <span className="text-xs text-muted-foreground">
            @{connector.connection.externalUsername}
          </span>
        ) : undefined
      }
      description={
        connector.description
          ? permissionDescription(connector.description)
          : undefined
      }
      enabled={enabled}
      loading={loading}
      showManage={showManage}
      isLast={isLast}
      onManage={onManage}
      onToggle={onToggle}
    />
  );
}

export function ConnectorCard(props: ConnectorCardProps) {
  if (props.variant === "catalog") {
    return <CatalogConnectorCard {...props} />;
  }
  if (props.variant === "connection") {
    return <ConnectionConnectorCard {...props} />;
  }
  if (props.variant === "accounts") {
    return <AccountsConnectorCard {...props} />;
  }
  if (props.variant === "onboarding") {
    return <OnboardingConnectorCard {...props} />;
  }
  if (props.variant === "action") {
    return <ActionConnectorCard {...props} />;
  }
  return <PermissionConnectorCard {...props} />;
}
