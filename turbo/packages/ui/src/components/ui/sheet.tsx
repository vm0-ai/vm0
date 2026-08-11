"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import {
  asChildRender,
  type LegacyAutoFocusHandler,
  withLegacyAutoFocus,
} from "../../lib/base-ui-compat";
import { cn } from "../../lib/utils";

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

interface SheetTriggerProps extends Omit<
  SheetPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: SheetPrimitive.Trigger.Props["render"];
}

const SheetTrigger = React.forwardRef<HTMLButtonElement, SheetTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <SheetPrimitive.Trigger
        ref={ref}
        data-slot="sheet-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </SheetPrimitive.Trigger>
    );
  },
);
SheetTrigger.displayName = "SheetTrigger";

interface SheetCloseProps extends Omit<SheetPrimitive.Close.Props, "render"> {
  asChild?: boolean;
  render?: SheetPrimitive.Close.Props["render"];
}

const SheetClose = React.forwardRef<HTMLButtonElement, SheetCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <SheetPrimitive.Close
        ref={ref}
        data-slot="sheet-close"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </SheetPrimitive.Close>
    );
  },
);
SheetClose.displayName = "SheetClose";

function SheetPortal(props: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

const SheetOverlay = React.forwardRef<
  HTMLDivElement,
  SheetPrimitive.Backdrop.Props
>(({ className, ...props }, ref) => {
  return (
    <SheetPrimitive.Backdrop
      ref={ref}
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-50", className)}
      {...props}
    />
  );
});
SheetOverlay.displayName = "SheetOverlay";

interface SheetContentProps extends SheetPrimitive.Popup.Props {
  onCloseAutoFocus?: LegacyAutoFocusHandler;
  onOpenAutoFocus?: LegacyAutoFocusHandler;
  side?: "top" | "bottom" | "left" | "right";
}

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  (
    {
      children,
      className,
      finalFocus,
      initialFocus,
      onCloseAutoFocus,
      onOpenAutoFocus,
      side = "right",
      ...props
    },
    ref,
  ) => {
    return (
      <SheetPortal>
        <SheetOverlay />
        <SheetPrimitive.Popup
          ref={ref}
          data-slot="sheet-content"
          data-side={side}
          className={cn(
            "sheet-content fixed z-50 flex flex-col gap-4 overflow-x-hidden bg-card p-6 outline-none",
            side === "right" &&
              "inset-y-0 right-0 h-full w-3/4 shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.1)] sm:max-w-lg dark:shadow-[-16px_0_48px_-8px_rgba(0,0,0,0.5)]",
            side === "left" &&
              "inset-y-0 left-0 h-full w-3/4 shadow-[8px_0_24px_-12px_rgba(0,0,0,0.1)] sm:max-w-md dark:shadow-[16px_0_48px_-8px_rgba(0,0,0,0.5)]",
            side === "top" && "inset-x-0 top-0",
            side === "bottom" && "inset-x-0 bottom-0",
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
          {...props}
        >
          {children}
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <button
                type="button"
                className="icon-button absolute right-4 top-4 opacity-70 hover:opacity-100"
                aria-label="Close"
              />
            }
          >
            <X size={20} className="text-foreground" />
          </SheetPrimitive.Close>
        </SheetPrimitive.Popup>
      </SheetPortal>
    );
  },
);
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col space-y-2 text-left", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
