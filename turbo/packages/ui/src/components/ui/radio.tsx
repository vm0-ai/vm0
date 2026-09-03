"use client";

import * as React from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "../../lib/utils";

const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupPrimitive.Props>(
  ({ className, ...props }, ref) => {
    return (
      <RadioGroupPrimitive
        ref={ref}
        data-slot="radio-group"
        className={className}
        {...props}
      />
    );
  },
);
RadioGroup.displayName = "RadioGroup";

// Round sibling of Checkbox: every value below is the one checkbox.tsx uses,
// so a radio and a checkbox read with the same weight in the same row.
const Radio = React.forwardRef<HTMLElement, RadioPrimitive.Root.Props>(
  ({ className, ...props }, ref) => {
    return (
      <RadioPrimitive.Root
        ref={ref}
        data-slot="radio"
        className={cn(
          "peer relative h-4 w-4 shrink-0 rounded-full border border-border bg-input transition-colors outline-none data-checked:border-primary data-checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50",
          className,
        )}
        {...props}
      >
        <RadioPrimitive.Indicator
          data-slot="radio-indicator"
          className="flex h-full w-full items-center justify-center"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--on-filled))]" />
        </RadioPrimitive.Indicator>
      </RadioPrimitive.Root>
    );
  },
);
Radio.displayName = "Radio";

export { Radio, RadioGroup };
