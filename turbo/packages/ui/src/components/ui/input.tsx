import * as React from "react";

import { cn } from "../../lib/utils";

// Form-input baseline — desktop is h-9 / text-sm, mobile bumps to h-12
// (48px touch target) and text-[16px] (min size that suppresses iOS Safari's
// focus auto-zoom). Keeping the mobile bump in the base means callsites no
// longer need to layer their own `max-md:h-11 max-md:text-[16px]` overrides
// — they all inherit it. Same recipe is mirrored on SelectTrigger.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 max-md:h-12 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 max-md:py-2.5 text-sm max-md:text-[16px] text-foreground placeholder:text-sm max-md:placeholder:text-[16px] placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          type === "password" &&
            "font-mono tracking-wider placeholder:font-sans placeholder:tracking-normal",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
