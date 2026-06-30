import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { IconDots } from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";

export interface AgentRowMenuAction {
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
}

function AgentUnreadIndicator() {
  return (
    <span aria-label="Unread" className="h-2 w-2 rounded-full bg-sky-600" />
  );
}

function triggerClassName(
  variant: "dialog" | "sidebar",
  isPrimarySelected: boolean,
) {
  if (variant === "sidebar") {
    return `peer pointer-events-auto absolute left-1 top-1 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
      isPrimarySelected
        ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
        : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
    }`;
  }

  return "peer absolute inset-0 z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted-foreground/12 hover:text-foreground dark:hover:bg-muted-foreground/18 disabled:cursor-not-allowed disabled:opacity-50";
}

const actionVisibilityStyle = {
  "--agent-row-trigger-opacity": 0,
  "--agent-row-unread-opacity": 1,
} as CSSProperties;

const triggerOpacityStyle = {
  opacity: "var(--agent-row-trigger-opacity)",
} as CSSProperties;

const unreadOpacityStyle = {
  opacity: "var(--agent-row-unread-opacity)",
} as CSSProperties;

function setActionVisibility(element: HTMLElement, visible: boolean) {
  element.style.setProperty("--agent-row-trigger-opacity", visible ? "1" : "0");
  element.style.setProperty("--agent-row-unread-opacity", visible ? "0" : "1");
}

export function AgentRowSideActions({
  hasUnread,
  action,
  actions,
  variant = "dialog",
  isPrimarySelected = false,
}: {
  readonly hasUnread: boolean;
  readonly action?: AgentRowMenuAction | undefined;
  readonly actions?: readonly AgentRowMenuAction[] | undefined;
  readonly variant?: "dialog" | "sidebar" | undefined;
  readonly isPrimarySelected?: boolean | undefined;
}) {
  const menuActions = actions ?? (action ? [action] : []);
  const hasMenuActions = menuActions.length > 0;

  if (!hasUnread && !hasMenuActions) {
    return null;
  }

  const triggerDisabled = menuActions.every((menuAction) => {
    return menuAction.disabled;
  });

  function handleMenuTriggerClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      onPointerEnter={(e) => {
        setActionVisibility(e.currentTarget, true);
      }}
      onPointerLeave={(e) => {
        setActionVisibility(e.currentTarget, false);
      }}
      onFocusCapture={(e) => {
        setActionVisibility(e.currentTarget, true);
      }}
      onBlurCapture={(e) => {
        setActionVisibility(e.currentTarget, false);
      }}
      style={hasMenuActions ? actionVisibilityStyle : undefined}
      className={
        variant === "sidebar"
          ? `absolute right-0 top-0 flex h-8 w-8 items-center justify-center ${
              hasMenuActions ? "" : "pointer-events-none"
            }`
          : `relative flex h-8 w-8 shrink-0 items-center justify-center ${
              hasMenuActions ? "" : "pointer-events-none"
            }`
      }
    >
      {hasMenuActions ? (
        <TooltipProvider delayDuration={200}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={triggerClassName(variant, isPrimarySelected)}
                style={triggerOpacityStyle}
                onClick={handleMenuTriggerClick}
                aria-label="Open agent menu"
                disabled={triggerDisabled}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex h-full w-full items-center justify-center">
                      <IconDots size={16} stroke={2} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side={variant === "sidebar" ? "bottom" : "right"}
                  >
                    <p className="text-xs">More</p>
                  </TooltipContent>
                </Tooltip>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {menuActions.map((menuAction) => {
                return (
                  <DropdownMenuItem
                    key={menuAction.label}
                    className="gap-2"
                    onSelect={menuAction.onSelect}
                    disabled={menuAction.disabled}
                  >
                    {menuAction.icon}
                    {menuAction.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      ) : null}
      {hasUnread ? (
        <span
          className="pointer-events-none flex items-center justify-center transition-opacity duration-150"
          style={hasMenuActions ? unreadOpacityStyle : undefined}
        >
          <AgentUnreadIndicator />
        </span>
      ) : null}
    </div>
  );
}
