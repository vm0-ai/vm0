import { IconLoader2 } from "@tabler/icons-react";
import { Switch, cn } from "@vm0/ui";

/** Track/thumb sizing shared with plain `Switch` when toggles must align (e.g. settings rows). */
export const compactSwitchClassName =
  "shrink-0 h-5 w-9 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4";

interface LoadingSwitchProps {
  checked: boolean;
  loading?: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel?: string;
}

export function LoadingSwitch({
  checked,
  loading = false,
  onCheckedChange,
  ariaLabel,
}: LoadingSwitchProps) {
  return (
    <div className="relative shrink-0 h-5 w-9">
      <Switch
        checked={checked}
        disabled={loading}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        className={compactSwitchClassName}
      />
      {loading && (
        <IconLoader2
          size={10}
          stroke={2.5}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 animate-spin text-muted-foreground/70",
            checked ? "left-1" : "right-1",
          )}
        />
      )}
    </div>
  );
}
