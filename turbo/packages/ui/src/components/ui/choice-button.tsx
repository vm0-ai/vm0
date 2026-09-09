import type { ComponentProps } from "react";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";

const choiceButtonVariants = cva(
  "rounded-lg border-[0.7px] text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed",
  {
    variants: {
      layout: {
        inline: "flex items-center gap-2 px-3.5 py-2",
        tile: "block w-full min-w-0 px-3 py-2.5",
      },
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
  layout?: "inline" | "tile";
}

/** A standalone selectable choice that retains native button and ref behavior. */
export function ChoiceButton({
  selected,
  layout = "inline",
  className,
  children,
  ...props
}: ChoiceButtonProps) {
  return (
    <button
      type="button"
      {...props}
      aria-pressed={selected}
      className={cn(choiceButtonVariants({ selected, layout }), className)}
    >
      {children}
    </button>
  );
}
