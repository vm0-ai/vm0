import type { ReactNode } from "react";
import { cn } from "@vm0/ui";

export function InlineSettingsRow({
  label,
  description,
  children,
  alignControls = "start",
  /** Use full width of the controls column (e.g. tone preview) instead of capping at 28rem. */
  wideControls = false,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  /** "center" vertically centers the control with the label column (e.g. a single toggle). */
  alignControls?: "start" | "center";
  wideControls?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 py-4 border-b border-border/50 first:pt-0 last:border-b-0 sm:flex-row sm:justify-between sm:gap-6",
        alignControls === "center" ? "sm:items-center" : "sm:items-start",
      )}
    >
      <div className="min-w-0 w-full sm:w-[46%] sm:shrink-0 sm:self-start">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="text-xs text-muted-foreground mt-1 leading-snug">
            {description}
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "min-w-0 w-full",
          wideControls
            ? "sm:min-w-0 sm:flex-1 sm:max-w-none sm:pt-0.5"
            : alignControls === "center"
              ? "flex justify-end sm:max-w-[min(100%,28rem)]"
              : "sm:flex sm:max-w-[min(100%,28rem)] sm:justify-end sm:pt-0.5",
        )}
      >
        {children}
      </div>
    </div>
  );
}
