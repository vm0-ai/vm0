import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-pressed",
        outline:
          "border-[0.7px] border-[hsl(var(--gray-400))] bg-background hover:bg-state-hover active:bg-state-pressed text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-pressed",
        ghost: "text-primary hover:bg-state-hover active:bg-state-pressed",
        // Neutral counterpart to `ghost`, for chrome that must not read as an
        // action: toolbar and composer icons, which inherit the muted ramp and
        // only gain weight on hover.
        quiet:
          "text-muted-foreground hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
        link: "text-primary underline-offset-4 hover:underline active:text-primary/80",
      },
      size: {
        xs: "h-7 px-2.5",
        sm: "h-8 px-3",
        default: "h-9 px-4",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
