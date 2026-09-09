import type { ComponentProps } from "react";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";

const choiceButtonVariants = cva(
  "flex items-center gap-2 rounded-lg border-[0.7px] px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed",
  {
    variants: {
      selected: {
        true: "border-primary/40 bg-primary/10 text-brand-text dark:border-primary/50 dark:bg-primary/15",
        // Preserve the opaque fill and the legacy hover layer on touch devices.
        false:
          "border-control-border bg-control-surface text-muted-foreground [&:hover]:bg-state-hover-overlay hover:text-foreground",
      },
    },
  },
);

interface ChoiceButtonProps extends Omit<
  ComponentProps<"button">,
  "aria-pressed"
> {
  selected: boolean;
}

/** A standalone selectable choice that retains native button and ref behavior. */
export function ChoiceButton({
  selected,
  className,
  children,
  ...props
}: ChoiceButtonProps) {
  return (
    <button
      type="button"
      {...props}
      aria-pressed={selected}
      className={cn(choiceButtonVariants({ selected }), className)}
    >
      {children}
    </button>
  );
}
