import type { ReactNode } from "react";

import { cn } from "@okouai/ui";

export interface WorkflowAutomationCardRow {
  readonly label: string;
  readonly value: ReactNode;
}

interface WorkflowAutomationCardProps {
  readonly rows: readonly WorkflowAutomationCardRow[];
  readonly actions?: ReactNode;
  readonly dimmed?: boolean;
  readonly className?: string;
}

export function WorkflowAutomationCard({
  rows,
  actions,
  dimmed,
  className,
}: WorkflowAutomationCardProps) {
  return (
    <article
      className={cn(
        "okou-card overflow-hidden transition-colors",
        dimmed && "opacity-75",
        className,
      )}
    >
      <dl className="px-5 py-1">
        {rows.map((row) => {
          return (
            <div
              key={row.label}
              className="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 py-3 last:border-b-0"
            >
              <dt className="shrink-0 text-sm text-muted-foreground">
                {row.label}
              </dt>
              <dd className="min-w-0 truncate text-right text-sm font-medium text-foreground">
                {row.value}
              </dd>
            </div>
          );
        })}
      </dl>
      {actions ? (
        <div className="flex min-w-0 items-center justify-between gap-2 px-5 pb-4 pt-2">
          {actions}
        </div>
      ) : null}
    </article>
  );
}
