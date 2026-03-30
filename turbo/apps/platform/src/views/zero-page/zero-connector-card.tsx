import { IconPlug, IconLoader2, IconDotsVertical } from "@tabler/icons-react";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import type { ConnectorTypeWithStatus } from "../../signals/zero-page/settings/connectors.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vm0/ui";

interface ZeroConnectorCardProps {
  name: string;
  label: string;
  connector: ConnectorTypeWithStatus | null;
  pollingType: ConnectorType | null;
  hasFirewallPermissions: boolean;
  isAdmin?: boolean;
  /** When true, hide agent-level mutations (remove connector). Connect/Disconnect still works. */
  readOnly?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onReviewScopes?: () => void;
  onManagePermissions?: () => void;
}

function ConnectionStatus({
  connector,
  isPolling,
  onConnect,
  onReviewScopes,
}: {
  connector: ConnectorTypeWithStatus | null;
  isPolling: boolean;
  onConnect: () => void;
  onReviewScopes?: () => void;
}) {
  if (!connector) {
    return <span className="text-xs text-muted-foreground">Added</span>;
  }

  if (isPolling) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
        Connecting…
      </span>
    );
  }

  if (connector.connected && connector.needsReconnect) {
    return (
      <span className="flex items-center gap-2 text-xs truncate">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
        <span className="text-amber-600 dark:text-amber-400">
          Connection expired
        </span>
        <button
          type="button"
          onClick={onConnect}
          className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
        >
          Reconnect
        </button>
      </span>
    );
  }

  if (connector.connected && connector.scopeMismatch) {
    return (
      <span className="flex items-center gap-2 text-xs truncate">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
        <span className="text-amber-600 dark:text-amber-400">
          Permissions update available
        </span>
        <button
          type="button"
          onClick={onReviewScopes}
          className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
        >
          Review
        </button>
      </span>
    );
  }

  if (connector.connected) {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
        {connector.connector?.externalUsername
          ? `@${connector.connector.externalUsername}`
          : "Connected"}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
    >
      Connect
    </button>
  );
}

function CardDropdownMenu({
  connector,
  hasFirewallPermissions,
  isAdmin,
  readOnly,
  onDisconnect,
  onRemove,
  onManagePermissions,
}: {
  connector: ConnectorTypeWithStatus | null;
  hasFirewallPermissions: boolean;
  isAdmin?: boolean;
  readOnly?: boolean;
  onDisconnect: () => void;
  onRemove: () => void;
  onManagePermissions?: () => void;
}) {
  // Hide entire menu when readOnly and no actionable items (not connected)
  if (readOnly && !connector?.connected) {
    return null;
  }

  return (
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
        {hasFirewallPermissions && connector?.connected && isAdmin && (
          <>
            <DropdownMenuItem onClick={onManagePermissions}>
              Permissions
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {connector?.connected ? (
          <DropdownMenuItem onClick={onDisconnect}>Disconnect</DropdownMenuItem>
        ) : (
          !readOnly && (
            <DropdownMenuItem onClick={onRemove}>
              Remove connector
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ZeroConnectorCard({
  name,
  label,
  connector,
  pollingType,
  hasFirewallPermissions,
  isAdmin,
  readOnly,
  onConnect,
  onDisconnect,
  onRemove,
  onReviewScopes,
  onManagePermissions,
}: ZeroConnectorCardProps) {
  const isPolling = pollingType === name;

  return (
    <div className="flex flex-col rounded-xl bg-card shadow-[var(--zero-card-shadow)] zero-border">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {name in CONNECTOR_TYPES ? (
            <ConnectorIcon type={name as ConnectorType} size={20} />
          ) : (
            <IconPlug
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
          {label}
        </span>
      </div>

      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex items-center gap-2 min-w-0">
          <ConnectionStatus
            connector={connector}
            isPolling={isPolling}
            onConnect={onConnect}
            onReviewScopes={onReviewScopes}
          />
        </div>
        <CardDropdownMenu
          connector={connector}
          hasFirewallPermissions={hasFirewallPermissions}
          isAdmin={isAdmin}
          readOnly={readOnly}
          onDisconnect={onDisconnect}
          onRemove={onRemove}
          onManagePermissions={onManagePermissions}
        />
      </div>
    </div>
  );
}
