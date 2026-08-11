"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { asChildRender } from "../../lib/base-ui-compat";
import { cn } from "../../lib/utils";

interface TooltipProviderProps extends Omit<
  TooltipPrimitive.Provider.Props,
  "delay" | "timeout"
> {
  delay?: number;
  delayDuration?: number;
  skipDelayDuration?: number;
  timeout?: number;
}

function TooltipProvider({
  delay,
  delayDuration,
  skipDelayDuration,
  timeout,
  ...props
}: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay ?? delayDuration ?? 0}
      timeout={timeout ?? skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

interface TooltipTriggerProps extends Omit<
  TooltipPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: TooltipPrimitive.Trigger.Props["render"];
}

const TooltipTrigger = React.forwardRef<HTMLButtonElement, TooltipTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <TooltipPrimitive.Trigger
        ref={ref}
        data-slot="tooltip-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </TooltipPrimitive.Trigger>
    );
  },
);
TooltipTrigger.displayName = "TooltipTrigger";

type TooltipPositionerProps = Pick<
  TooltipPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "positionMethod"
  | "side"
  | "sideOffset"
>;

type TooltipContentProps = TooltipPrimitive.Popup.Props &
  TooltipPositionerProps & {
    portalContainer?: HTMLElement | null;
  };

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      align = "center",
      alignOffset = 0,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      portalContainer,
      positionMethod = "fixed",
      side = "top",
      sideOffset = 4,
      style,
      ...props
    },
    ref,
  ) => {
    return (
      <TooltipPrimitive.Portal container={portalContainer}>
        <TooltipPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          className="isolate z-50"
          collisionAvoidance={collisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
        >
          <TooltipPrimitive.Popup
            ref={ref}
            data-slot="tooltip-content"
            className={cn(
              "z-50 max-w-xs origin-[var(--transform-origin)] overflow-hidden rounded-md px-2 py-1 text-xs data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              className,
            )}
            style={
              typeof style === "function"
                ? (state) => {
                    return {
                      backgroundColor: "var(--tooltip-bg, #1a1a1a)",
                      color: "hsl(var(--on-filled))",
                      ...style(state),
                    };
                  }
                : {
                    backgroundColor: "var(--tooltip-bg, #1a1a1a)",
                    color: "hsl(var(--on-filled))",
                    ...style,
                  }
            }
            {...props}
          >
            {children}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
