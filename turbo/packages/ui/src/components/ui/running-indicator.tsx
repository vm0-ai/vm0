import { type HTMLAttributes, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

interface RunningIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

// Keep this in sync with the animation durations in globals.css.
const RUNNING_INDICATOR_CYCLE_MS = 2400;

function RunningIndicator({
  className,
  label = "Running",
  ...rest
}: RunningIndicatorProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // Anchor every indicator to the same wall-clock cycle grid via a negative
  // animation-delay so the pulses stay in phase regardless of when each row
  // mounts (e.g. virtualized sidebar rows that mount at different times).
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    node.style.setProperty(
      "--running-indicator-delay",
      `-${Date.now() % RUNNING_INDICATOR_CYCLE_MS}ms`,
    );
  }, []);
  return (
    <span
      ref={ref}
      aria-label={label}
      className={cn("running-indicator", className)}
      {...rest}
    >
      <span className="running-indicator-center" aria-hidden />
      <span className="running-indicator-ripple" aria-hidden />
    </span>
  );
}

export { RunningIndicator, type RunningIndicatorProps };
