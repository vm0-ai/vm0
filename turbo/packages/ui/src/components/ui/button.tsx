import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { asChildRender } from "../../lib/base-ui-compat";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

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
        ghost: "text-brand-text hover:bg-state-hover active:bg-state-pressed",
        // Neutral counterpart to `ghost`, for chrome that must not read as an
        // action: toolbar and composer icons, which inherit the muted ramp and
        // only gain weight on hover.
        quiet:
          "text-muted-foreground hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
        link: "text-brand-text underline-offset-4 hover:underline active:text-brand-text/80",
      },
      size: {
        xs: "h-7 px-2.5",
        sm: "h-8 px-3",
        default: "h-9 px-4",
        lg: "h-10 px-6",
        "icon-2xs": "h-6 w-6",
        "icon-xs": "h-7 w-7",
        "icon-sm": "h-8 w-8",
        icon: "h-9 w-9",
        "icon-lg": "h-10 w-10",
      },
      // Icon buttons across the app draw 16px, 18px, or 20px glyphs. The base
      // `[&_svg]:size-4` covers 16px; the other two need an explicit opt-in so
      // callers stop hand-rolling `[&_svg]:size-[18px]` on every toolbar.
      iconSize: {
        sm: "[&_svg]:size-4",
        md: "[&_svg]:size-[18px]",
        lg: "[&_svg]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonBaseProps
  extends
    Omit<ButtonPrimitive.Props, "className" | "render">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  className?: string;
  render?: ButtonPrimitive.Props["render"];
}

export type ButtonProps = ButtonBaseProps &
  (
    | {
        showTooltip: true;
        "aria-label": string;
      }
    | {
        showTooltip?: false;
      }
  );

interface ButtonAsChildProps {
  children: React.ReactNode;
  className: string;
  props: Omit<
    ButtonPrimitive.Props,
    "children" | "className" | "nativeButton" | "ref" | "render"
  >;
  ref: React.ForwardedRef<HTMLElement>;
}

function ButtonAsChild({
  children,
  className,
  props,
  ref,
}: ButtonAsChildProps) {
  return useRender({
    defaultTagName: "button",
    props: {
      ...props,
      className,
      "data-slot": "button",
    },
    ref,
    render: asChildRender(children),
  });
}

const Button = React.forwardRef<HTMLElement, ButtonProps>(
  (
    {
      asChild = false,
      children,
      className,
      iconSize,
      nativeButton,
      render,
      showTooltip = false,
      size,
      variant,
      ...props
    },
    ref,
  ) => {
    const resolvedClassName = cn(
      buttonVariants({ variant, size, iconSize, className }),
    );
    const { title: _title, ...propsWithoutTitle } = props;
    const buttonProps = showTooltip ? propsWithoutTitle : props;

    const button = asChild ? (
      <ButtonAsChild
        className={resolvedClassName}
        props={buttonProps}
        ref={ref}
      >
        {children}
      </ButtonAsChild>
    ) : (
      <ButtonPrimitive
        className={resolvedClassName}
        data-slot="button"
        nativeButton={nativeButton}
        ref={ref}
        render={render}
        {...buttonProps}
      >
        {children}
      </ButtonPrimitive>
    );

    if (!showTooltip) {
      return button;
    }

    const tooltipTrigger = buttonProps.disabled ? (
      <span className="inline-flex">{button}</span>
    ) : (
      button
    );

    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger render={tooltipTrigger} />
          <TooltipContent>
            <p className="text-xs">{buttonProps["aria-label"]}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
