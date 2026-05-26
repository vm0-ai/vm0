import type { ReactNode } from "react";

interface SettingsSectionHeadingProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function SettingsSectionHeading({
  title,
  description,
  action,
}: SettingsSectionHeadingProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description !== undefined && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}
