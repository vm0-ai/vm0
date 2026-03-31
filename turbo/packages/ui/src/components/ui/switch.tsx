"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "../../lib/utils";

const SIZES = {
  default: {
    root: "h-6 w-11",
    thumb:
      "h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
  },
  sm: {
    root: "h-4 w-7",
    thumb:
      "h-3 w-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0",
  },
} as const;

interface SwitchProps extends React.ComponentPropsWithoutRef<
  typeof SwitchPrimitives.Root
> {
  size?: keyof typeof SIZES;
}

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, size = "default", ...props }, ref) => {
  const s = SIZES[size];
  return (
    <SwitchPrimitives.Root
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted",
        s.root,
        className,
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          "pointer-events-none block rounded-full shadow-lg ring-0 transition-transform",
          s.thumb,
        )}
        style={{ backgroundColor: "#ffffff" }}
      />
    </SwitchPrimitives.Root>
  );
});
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
