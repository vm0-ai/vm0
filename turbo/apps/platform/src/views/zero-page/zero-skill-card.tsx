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
} from "@vm0/ui";

interface ZeroSkillCardProps {
  name: string;
  label: string;
  iconUrl: string | undefined;
  connector: ConnectorTypeWithStatus | null;
  pollingType: ConnectorType | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onReviewScopes?: () => void;
}

export function ZeroSkillCard({
  name,
  label,
  iconUrl,
  connector,
  pollingType,
  onConnect,
  onDisconnect,
  onRemove,
  onReviewScopes,
}: ZeroSkillCardProps) {
  const isPolling = pollingType === name;

  return (
    <div
      className="flex flex-col rounded-[var(--zero-card-radius)] bg-card shadow-[var(--zero-card-shadow)]"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
    >
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          {name in CONNECTOR_TYPES ? (
            <ConnectorIcon type={name as ConnectorType} size={22} />
          ) : iconUrl ? (
            <img src={iconUrl} alt="" className="h-5 w-5 object-contain" />
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
          {connector &&
            (isPolling ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
                Connecting…
              </span>
            ) : connector.connected && connector.needsReconnect ? (
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
            ) : connector.connected && connector.scopeMismatch ? (
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
            ) : connector.connected ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                {connector.connector?.externalUsername
                  ? `@${connector.connector.externalUsername}`
                  : "Connected"}
              </span>
            ) : (
              <button
                type="button"
                onClick={onConnect}
                className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Connect
              </button>
            ))}
          {!connector && (
            <span className="text-xs text-muted-foreground">Added</span>
          )}
        </div>
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
          <DropdownMenuContent align="end" className="w-40">
            {connector?.connected ? (
              <DropdownMenuItem onClick={onDisconnect}>
                Disconnect
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={onRemove}>
                Remove connector
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
