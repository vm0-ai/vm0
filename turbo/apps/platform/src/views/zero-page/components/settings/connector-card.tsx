import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAdjustmentsHorizontal,
  IconCircleCheck,
  IconDotsVertical,
  IconLoader2,
  IconPlus,
} from "@tabler/icons-react";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { PlatformConnectorCatalogStatusItem } from "../../../../signals/connector-domain.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import {
  connectorCurrentConnectionStatus,
  connectorExpiryCountdownText,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { DropdownMenuModalItem } from "../../../components/dropdown-menu-modal-item.tsx";
import { LoadingSwitch } from "../../../components/loading-switch.tsx";
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
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly connected: boolean;
  readonly complete: boolean;
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
            <IconLoader2 size={16} stroke={1.5} className="animate-spin" />
          ) : (
            <IconPlus size={14} stroke={1.5} />
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
        <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
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
      <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        <span className="truncate">{connectedText}</span>
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
        <div className="flex shrink-0 items-center gap-2 overflow-hidden">
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
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                  aria-label={t(($) => {
                    return $.connectors.custom.moreOptions;
                  })}
                  disabled={busy}
                >
                  <IconDotsVertical size={14} stroke={1.5} />
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
          <IconCircleCheck size={16} aria-hidden="true" />
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
            <IconLoader2 className="animate-spin" aria-hidden="true" />
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
  connector,
  connected,
  complete,
  busy,
  className,
  onActivate,
}: ActionConnectorCardProps) {
  const { t } = useTranslation();
  const reconnectRequired =
    connectorCurrentConnectionStatus(connector) === "reconnect-required";
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
          <ConnectorIcon icon={connector.icon} size={22} />
        </div>
        <div className="min-w-0">
          <div
            data-testid="connector-card-label"
            className="truncate text-[0.9375rem] font-medium text-foreground"
          >
            {connector.label}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {connector.description}
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={complete || busy}
        onClick={onActivate}
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {busy ? <IconLoader2 size={15} className="animate-spin" /> : null}
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
  const { t } = useTranslation();
  return (
    <>
      <div className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors">
        <ConnectorIcon icon={connector.icon} size={20} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              data-testid="connector-card-label"
              className="text-sm font-medium text-foreground"
            >
              {connector.label}
            </span>
            {connector.connection?.externalUsername ? (
              <span className="text-xs text-muted-foreground">
                @{connector.connection.externalUsername}
              </span>
            ) : null}
          </div>
          {connector.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {permissionDescription(connector.description)}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showManage ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onManage}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={t(
                      ($) => {
                        return $.connectors.card.managePermissionsFor;
                      },
                      { connector: connector.label },
                    )}
                  >
                    <IconAdjustmentsHorizontal size={15} stroke={1.5} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">
                    {t(($) => {
                      return $.connectors.card.managePermissions;
                    })}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <LoadingSwitch
            checked={enabled}
            onCheckedChange={onToggle}
            loading={loading}
            ariaLabel={t(
              ($) => {
                return $.connectors.card.accessFor;
              },
              {
                action: enabled
                  ? t(($) => {
                      return $.connectors.actions.revoke;
                    })
                  : t(($) => {
                      return $.connectors.actions.grant;
                    }),
                connector: connector.label,
              },
            )}
          />
        </div>
      </div>
      {!isLast ? <div className="mx-5 border-b border-border/50" /> : null}
    </>
  );
}

export function ConnectorCard(props: ConnectorCardProps) {
  if (props.variant === "catalog") {
    return <CatalogConnectorCard {...props} />;
  }
  if (props.variant === "connection") {
    return <ConnectionConnectorCard {...props} />;
  }
  if (props.variant === "onboarding") {
    return <OnboardingConnectorCard {...props} />;
  }
  if (props.variant === "action") {
    return <ActionConnectorCard {...props} />;
  }
  return <PermissionConnectorCard {...props} />;
}
