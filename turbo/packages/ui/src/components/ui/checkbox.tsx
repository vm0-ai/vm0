"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

import { cn } from "../../lib/utils";

type CheckedState = boolean | "indeterminate";

interface CheckboxProps extends Omit<
  CheckboxPrimitive.Root.Props,
  "checked" | "defaultChecked" | "onCheckedChange"
> {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
}

const Checkbox = React.forwardRef<HTMLElement, CheckboxProps>(
  (
    {
      checked,
      className,
      defaultChecked,
      indeterminate,
      onCheckedChange,
      ...props
    },
    ref,
  ) => {
    const [defaultIndeterminate, setDefaultIndeterminate] = React.useState(
      defaultChecked === "indeterminate",
    );
    const resolvedIndeterminate =
      indeterminate ??
      (checked === undefined
        ? defaultIndeterminate
        : checked === "indeterminate");

    return (
      <CheckboxPrimitive.Root
        ref={ref}
        checked={checked === undefined ? undefined : checked === true}
        defaultChecked={
          defaultChecked === undefined ? undefined : defaultChecked === true
        }
        data-slot="checkbox"
        className={cn(
          "peer relative h-4 w-4 shrink-0 rounded-md border border-border bg-input transition-colors outline-none data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50",
          className,
        )}
        indeterminate={resolvedIndeterminate}
        onCheckedChange={(nextChecked) => {
          setDefaultIndeterminate(false);
          onCheckedChange?.(nextChecked);
        }}
        {...props}
      >
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          className="flex h-full w-full items-center justify-center text-[hsl(var(--on-filled))]"
        >
          <Check className="h-3.5 w-3.5" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
