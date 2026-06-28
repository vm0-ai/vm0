import type { ReactNode } from "react";

import { cn } from "@vm0/ui";

export interface WorkflowTriggerCardRow {
  readonly label: string;
  readonly value: ReactNode;
}

interface WorkflowTriggerCardProps {
  readonly rows: readonly WorkflowTriggerCardRow[];
  readonly actions?: ReactNode;
  readonly dimmed?: boolean;
  readonly className?: string;
}

export function WorkflowTriggerCard({
  rows,
  actions,
  dimmed,
  className,
}: WorkflowTriggerCardProps) {
  return (
    <article
      className={cn(
        "zero-card overflow-hidden transition-colors",
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
