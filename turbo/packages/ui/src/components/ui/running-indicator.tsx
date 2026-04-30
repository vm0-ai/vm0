import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const RUNNING_INDICATOR_DURATION_MS = 2400;

interface RunningIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

function RunningIndicator({
  className,
  label = "Running",
  ...rest
}: RunningIndicatorProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    // getAnimations is unavailable in some non-browser test DOMs (e.g.
    // happy-dom); skip phase syncing there.
    if (!el || typeof el.getAnimations !== "function") {
      return;
    }
    // Anchor every indicator's animation phase to wall-clock time, so
    // instances mounted at different moments stay visually synchronized.
    const phase = Date.now() % RUNNING_INDICATOR_DURATION_MS;
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.currentTime = phase;
    }
  }, []);
  return (
    <span
      ref={ref}
      aria-label={label}
      className={cn("running-indicator", className)}
      {...rest}
    />
  );
}

export { RunningIndicator, type RunningIndicatorProps };
