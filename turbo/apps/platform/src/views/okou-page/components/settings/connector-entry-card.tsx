import type { ReactNode } from "react";
import { cn, surfaceVariants } from "@okouai/ui";

/** Shared directory presentation, independent of account or authorization models. */
export function ConnectorEntryCard({
  icon,
  label,
  description,
  showDescription,
  indicator,
  status,
  trailingAction,
  action,
  interactive,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  readonly showDescription: boolean;
  readonly indicator?: ReactNode;
  readonly status?: ReactNode;
  readonly trailingAction?: ReactNode;
  readonly action: ReactNode;
  readonly interactive: boolean;
}) {
  return (
    <div
      data-slot="connector-entry-card"
      className={cn(
        surfaceVariants({ interactive }),
        "relative flex flex-col text-left",
        showDescription && "overflow-hidden",
        interactive && "cursor-pointer",
      )}
    >
      {action}
      <div
        className={cn(
          "flex items-center gap-2.5 px-5",
          showDescription ? "pb-1 pt-4" : "h-14",
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {label}
        </span>
        {indicator}
      </div>
      {showDescription ? (
        <div className="px-5 pb-4 pt-1">
          <div
            data-testid="connector-help-text"
            className="line-clamp-2 text-xs text-muted-foreground"
          >
            {description}
          </div>
        </div>
      ) : (
        <div className="flex h-11 items-center gap-2 border-t border-border/50 pl-5 pr-2">
          {status}
          {trailingAction}
        </div>
      )}
    </div>
  );
}
