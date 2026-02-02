"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { IconCheck } from "@tabler/icons-react";

import { cn } from "../../lib/utils";

const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, style, checked, defaultChecked, ...props }, ref) => {
  const [isChecked, setIsChecked] = React.useState(
    defaultChecked || checked || false,
  );

  React.useEffect(() => {
    if (checked !== undefined) {
      setIsChecked(checked);
    }
  }, [checked]);

  return (
    <CheckboxPrimitive.Root
      ref={ref}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(newChecked) => {
        setIsChecked(newChecked === true);
        props.onCheckedChange?.(newChecked);
      }}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      style={{
        backgroundColor: isChecked
          ? "hsl(var(--primary))"
          : "hsl(var(--input))",
        borderColor: isChecked ? "hsl(var(--primary))" : "hsl(var(--border))",
        ...style,
      }}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex h-full w-full items-center justify-center">
        <IconCheck
          className="h-3.5 w-3.5"
          style={{
            stroke: "hsl(var(--on-filled))",
            strokeWidth: 2.5,
          }}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
