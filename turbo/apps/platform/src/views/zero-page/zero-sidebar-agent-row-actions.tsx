import type { MouseEvent, ReactNode } from "react";
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
    return `peer pointer-events-auto absolute left-1 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible group-focus-within:visible data-[state=open]:visible transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
      isPrimarySelected
        ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
        : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
    }`;
  }

  return "peer absolute inset-0 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground invisible transition-colors duration-150 group-hover:visible group-focus-within:visible data-[state=open]:visible hover:bg-muted-foreground/12 hover:text-foreground dark:hover:bg-muted-foreground/18 disabled:cursor-not-allowed disabled:opacity-50";
}

export function AgentRowSideActions({
  hasUnread,
  action,
  variant = "dialog",
  isPrimarySelected = false,
}: {
  readonly hasUnread: boolean;
  readonly action?: AgentRowMenuAction | undefined;
  readonly variant?: "dialog" | "sidebar" | undefined;
  readonly isPrimarySelected?: boolean | undefined;
}) {
  if (!hasUnread && !action) {
    return null;
  }

  function handleMenuTriggerClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      className={
        variant === "sidebar"
          ? "pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center"
          : "relative flex h-8 w-8 shrink-0 items-center justify-center"
      }
    >
      {action ? (
        <TooltipProvider delayDuration={200}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={triggerClassName(variant, isPrimarySelected)}
                onClick={handleMenuTriggerClick}
                aria-label="Open agent menu"
                disabled={action.disabled}
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
              <DropdownMenuItem
                className="gap-2"
                onSelect={action.onSelect}
                disabled={action.disabled}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      ) : null}
      {hasUnread ? (
        <span className="flex items-center justify-center group-hover:hidden group-focus-within:hidden peer-data-[state=open]:hidden">
          <AgentUnreadIndicator />
        </span>
      ) : null}
    </div>
  );
}
