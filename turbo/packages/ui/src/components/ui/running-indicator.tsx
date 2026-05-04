import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

interface RunningIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

function RunningIndicator({
  className,
  label = "Running",
  ...rest
}: RunningIndicatorProps) {
  return (
    <span
      aria-label={label}
      className={cn("running-indicator", className)}
      {...rest}
    />
  );
}

export { RunningIndicator, type RunningIndicatorProps };
