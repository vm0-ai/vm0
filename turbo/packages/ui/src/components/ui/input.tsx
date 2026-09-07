import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "../../lib/utils";

const inputClassName =
  "flex h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-[var(--okou-input-padding-inline)] py-[var(--okou-input-padding-block)] text-sm text-foreground placeholder:text-sm placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          inputClassName,
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

export { Input, inputClassName };
