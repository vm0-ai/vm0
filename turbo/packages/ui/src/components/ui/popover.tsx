"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRender } from "@base-ui/react/use-render";

import {
  asChildRender,
  type LegacyAutoFocusHandler,
  withLegacyAutoFocus,
} from "../../lib/base-ui-compat";
import { cn } from "../../lib/utils";

interface VirtualAnchor {
  readonly contextElement?: Element;
  getBoundingClientRect(): DOMRect;
}

interface PopoverAnchorContextValue {
  readonly anchorRef: React.RefObject<Element | VirtualAnchor | null>;
  readonly hasAnchor: boolean;
  readonly setAnchor: (anchor: Element | VirtualAnchor | null) => void;
}

const PopoverAnchorContext = React.createContext<
  PopoverAnchorContextValue | undefined
>(undefined);

function Popover(props: PopoverPrimitive.Root.Props) {
  const anchorRef = React.useRef<Element | VirtualAnchor | null>(null);
  const [hasAnchor, setHasAnchor] = React.useState(false);
  const setAnchor = React.useCallback(
    (anchor: Element | VirtualAnchor | null) => {
      anchorRef.current = anchor;
      setHasAnchor(anchor !== null);
    },
    [],
  );
  const context = React.useMemo(() => {
    return { anchorRef, hasAnchor, setAnchor };
  }, [hasAnchor, setAnchor]);

  return (
    <PopoverAnchorContext.Provider value={context}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PopoverAnchorContext.Provider>
  );
}

interface PopoverTriggerProps extends Omit<
  PopoverPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: PopoverPrimitive.Trigger.Props["render"];
}

const PopoverTrigger = React.forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <PopoverPrimitive.Trigger
        ref={ref}
        data-slot="popover-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </PopoverPrimitive.Trigger>
    );
  },
);
PopoverTrigger.displayName = "PopoverTrigger";

interface PopoverAnchorProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean;
  virtualRef?: React.RefObject<VirtualAnchor | null>;
}

const PopoverAnchor = React.forwardRef<HTMLElement, PopoverAnchorProps>(
  ({ asChild = false, children, virtualRef, ...props }, ref) => {
    const context = React.useContext(PopoverAnchorContext);
    if (!context) {
      throw new Error("PopoverAnchor must be used within Popover");
    }
    const { setAnchor } = context;
    const setElement = React.useCallback(
      (element: HTMLElement | null) => {
        setAnchor(element);
      },
      [setAnchor],
    );

    React.useLayoutEffect(() => {
      if (!virtualRef) {
        return;
      }
      setAnchor(virtualRef.current);
      return () => {
        setAnchor(null);
      };
    }, [setAnchor, virtualRef]);

    return useRender({
      defaultTagName: "span",
      enabled: !virtualRef,
      props: {
        ...props,
        children: asChild ? undefined : children,
        "data-slot": "popover-anchor",
      },
      ref: [ref, setElement],
      render: asChild ? asChildRender(children) : undefined,
    });
  },
);
PopoverAnchor.displayName = "PopoverAnchor";

interface PopoverCloseProps extends Omit<
  PopoverPrimitive.Close.Props,
  "render"
> {
  asChild?: boolean;
  render?: PopoverPrimitive.Close.Props["render"];
}

const PopoverClose = React.forwardRef<HTMLButtonElement, PopoverCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <PopoverPrimitive.Close
        ref={ref}
        data-slot="popover-close"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </PopoverPrimitive.Close>
    );
  },
);
PopoverClose.displayName = "PopoverClose";

const PopoverOverlay = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button">
>(
  (
    {
      "aria-label": ariaLabel = "Close popover",
      className,
      tabIndex = -1,
      type = "button",
      ...props
    },
    ref,
  ) => {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Close
          render={
            <button
              ref={ref}
              type={type}
              tabIndex={tabIndex}
              aria-label={ariaLabel}
              className={cn(
                "fixed inset-0 z-40 cursor-default appearance-none border-0 bg-transparent p-0 outline-none",
                className,
              )}
              {...props}
            />
          }
        />
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverOverlay.displayName = "PopoverOverlay";

type PopoverPositionerProps = Pick<
  PopoverPrimitive.Positioner.Props,
  | "align"
  | "alignOffset"
  | "anchor"
  | "collisionAvoidance"
  | "collisionBoundary"
  | "collisionPadding"
  | "disableAnchorTracking"
  | "positionMethod"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type PopoverContentProps = PopoverPrimitive.Popup.Props &
  PopoverPositionerProps & {
    avoidCollisions?: boolean;
    hideWhenDetached?: boolean;
    onCloseAutoFocus?: LegacyAutoFocusHandler;
    onOpenAutoFocus?: LegacyAutoFocusHandler;
    portalContainer?: HTMLElement | null;
    positionerClassName?: string;
    updatePositionStrategy?: "always" | "optimized";
  };

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = "center",
      alignOffset = 0,
      anchor,
      avoidCollisions,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      disableAnchorTracking,
      finalFocus,
      hideWhenDetached = false,
      initialFocus,
      onCloseAutoFocus,
      onOpenAutoFocus,
      portalContainer,
      positionMethod = "fixed",
      positionerClassName,
      side = "bottom",
      sideOffset = 4,
      sticky,
      style,
      updatePositionStrategy,
      ...props
    },
    ref,
  ) => {
    const anchorContext = React.useContext(PopoverAnchorContext);
    const resolvedAnchor =
      anchor ??
      (anchorContext?.hasAnchor
        ? () => {
            return anchorContext.anchorRef.current;
          }
        : undefined);
    const resolvedCollisionAvoidance =
      collisionAvoidance ??
      (avoidCollisions === false
        ? {
            align: "none" as const,
            fallbackAxisSide: "none" as const,
            side: "none" as const,
          }
        : undefined);

    return (
      <PopoverPrimitive.Portal container={portalContainer}>
        <PopoverPrimitive.Positioner
          align={align}
          alignOffset={alignOffset}
          anchor={resolvedAnchor}
          className={cn(
            "isolate z-50",
            positionerClassName,
            hideWhenDetached && "data-anchor-hidden:invisible",
          )}
          collisionAvoidance={resolvedCollisionAvoidance}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          disableAnchorTracking={
            disableAnchorTracking ?? updatePositionStrategy === "optimized"
          }
          positionMethod={positionMethod}
          side={side}
          sideOffset={sideOffset}
          sticky={sticky}
        >
          <PopoverPrimitive.Popup
            ref={ref}
            data-slot="popover-content"
            className={cn(
              "z-50 w-72 origin-[var(--transform-origin)] rounded-[12px] border-[0.7px] border-[hsl(var(--gray-400))] bg-card p-4 text-foreground outline-none data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              className,
            )}
            finalFocus={withLegacyAutoFocus(
              finalFocus,
              onCloseAutoFocus,
              "closeAutoFocus",
            )}
            initialFocus={withLegacyAutoFocus(
              initialFocus,
              onOpenAutoFocus,
              "openAutoFocus",
            )}
            style={
              typeof style === "function"
                ? (state) => {
                    return {
                      boxShadow:
                        "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                      ...style(state),
                    };
                  }
                : {
                    boxShadow:
                      "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                    ...style,
                  }
            }
            {...props}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = "PopoverContent";

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverClose,
  PopoverOverlay,
};
