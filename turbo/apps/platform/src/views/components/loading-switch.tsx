import { IconLoader2 } from "@tabler/icons-react";
import { Switch, cn } from "@vm0/ui";

/** Track/thumb sizing shared with plain `Switch` when toggles must align (e.g. settings rows). */
const compactSwitchClassName =
  "shrink-0 h-5 w-9 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4";

interface LoadingSwitchProps {
  checked: boolean;
  loading?: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel?: string;
  size?: "default" | "sm";
}

export function LoadingSwitch({
  checked,
  loading = false,
  onCheckedChange,
  ariaLabel,
  size = "default",
}: LoadingSwitchProps) {
  return (
    <div
      className={cn(
        "relative shrink-0 flex items-center",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
      )}
    >
      <Switch
        checked={checked}
        disabled={loading}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        size={size}
        className={size === "default" ? compactSwitchClassName : undefined}
      />
      {loading && (
        <IconLoader2
          size={10}
          stroke={2.5}
          className={cn(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-muted-foreground/70",
            checked ? "left-1/4" : "left-3/4",
          )}
        />
      )}
    </div>
  );
}
