import { Loader2 } from "lucide-react";
import { Switch, cn } from "@okouai/ui";

interface LoadingSwitchProps {
  checked: boolean;
  loading?: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel?: string;
  size?: "default" | "sm";
}

export function LoadingSwitch({
  checked,
  loading = false,
  disabled = false,
  onCheckedChange,
  ariaLabel,
  size = "default",
}: LoadingSwitchProps) {
  return (
    <span
      className={cn(
        "relative shrink-0 flex items-center",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
      )}
    >
      <Switch
        checked={checked}
        disabled={loading || disabled}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        size={size === "default" ? "compact" : size}
        className="shrink-0"
      />
      {loading && (
        <Loader2
          size={10}
          className={cn(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-muted-foreground/70",
            checked ? "left-1/4" : "left-3/4",
          )}
        />
      )}
    </span>
  );
}
