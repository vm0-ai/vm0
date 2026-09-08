"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { asChildRender } from "../../lib/base-ui-compat";
import {
  dialogBackdropAnimationClassName,
  dialogPopupAnimationClassName,
} from "./popup-motion";
import { cn } from "../../lib/utils";

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

interface DialogTriggerProps extends Omit<
  DialogPrimitive.Trigger.Props,
  "render"
> {
  asChild?: boolean;
  render?: DialogPrimitive.Trigger.Props["render"];
}

const DialogTrigger = React.forwardRef<HTMLButtonElement, DialogTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <DialogPrimitive.Trigger
        ref={ref}
        data-slot="dialog-trigger"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </DialogPrimitive.Trigger>
    );
  },
);
DialogTrigger.displayName = "DialogTrigger";

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

interface DialogCloseProps extends Omit<DialogPrimitive.Close.Props, "render"> {
  asChild?: boolean;
  render?: DialogPrimitive.Close.Props["render"];
}

const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const child = asChild ? asChildRender(children) : undefined;
    return (
      <DialogPrimitive.Close
        ref={ref}
        data-slot="dialog-close"
        render={child ?? render}
        {...props}
      >
        {asChild ? undefined : children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = "DialogClose";

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  DialogPrimitive.Backdrop.Props
>(({ className, ...props }, ref) => {
  return (
    <DialogPrimitive.Backdrop
      ref={ref}
      data-slot="dialog-overlay"
      className={cn(
        dialogBackdropAnimationClassName,
        "fixed inset-0 bg-overlay/45 dark:bg-overlay/55",
        className,
      )}
      {...props}
    />
  );
});
DialogOverlay.displayName = "DialogOverlay";

// Preferred sizes are clamped by the viewport, including for future callers.
// Numeric variants preserve the existing dialogs' desktop dimensions.
const dialogSizeClasses = {
  sm: "w-96",
  md: "w-md",
  lg: "w-lg",
  xl: "w-xl",
  "2xl": "w-2xl",
  "3xl": "w-3xl",
  "4xl": "w-4xl",
  "6xl": "w-6xl",
  400: "w-[400px]",
  420: "w-[420px]",
  424: "w-[424px]",
  440: "w-[440px]",
  480: "w-[480px]",
  560: "w-[560px]",
  640: "w-[640px]",
  680: "w-[680px]",
  720: "w-[720px]",
  760: "w-[760px]",
  820: "w-[820px]",
  860: "w-[860px]",
  880: "w-[880px]",
  1120: "w-[1120px]",
  1200: "w-[1200px]",
  preview: "w-[1440px]",
} as const;

const dialogHeightClasses = {
  content: "h-auto",
  fill: "h-full",
  688: "h-[688px]",
  720: "h-[720px]",
  760: "h-[760px]",
  800: "h-[800px]",
  1000: "h-[1000px]",
} as const;

interface DialogContentProps extends Omit<
  DialogPrimitive.Popup.Props,
  "className" | "style" | "render"
> {
  readonly closeLabel?: string;
  /** Styles the inner content, never the viewport or popup boundary. */
  readonly contentClassName?: string;
  readonly size?: keyof typeof dialogSizeClasses;
  readonly height?: keyof typeof dialogHeightClasses;
  readonly mode?: "windowed" | "fullscreen";
  readonly surface?: "card" | "canvas" | "transparent";
  readonly overlayClassName?: string;
  readonly showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      children,
      contentClassName,
      closeLabel = "Close",
      size = "lg",
      height = size === "preview" ? 1000 : "content",
      mode = "windowed",
      surface = "card",
      overlayClassName,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => {
    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} forceRender />
        <DialogPrimitive.Viewport
          data-slot="dialog-viewport"
          className={cn(
            "fixed inset-x-0 top-0 flex h-[var(--okou-viewport-height,100dvh)] items-center justify-center overflow-hidden",
            mode === "windowed" && [
              "pt-[calc(var(--sat,env(safe-area-inset-top,0px))+1.5rem)]",
              "pr-[calc(var(--sar,env(safe-area-inset-right,0px))+1.5rem)]",
              "pb-[calc(var(--sab,env(safe-area-inset-bottom,0px))+1.5rem)]",
              "pl-[calc(var(--sal,env(safe-area-inset-left,0px))+1.5rem)]",
            ],
          )}
        >
          <DialogPrimitive.Popup
            {...props}
            ref={ref}
            data-slot="dialog-content"
            data-mode={mode}
            // Keep geometry owned here even when props arrive through a spread.
            style={undefined}
            render={undefined}
            className={cn(
              dialogPopupAnimationClassName,
              "relative flex min-h-0 min-w-0 max-h-full max-w-full flex-col overflow-hidden outline-none contain-layout",
              surface === "card" && "bg-card",
              surface === "canvas" && "bg-background",
              mode === "windowed"
                ? [
                    dialogSizeClasses[size],
                    dialogHeightClasses[height],
                    "rounded-xl",
                    surface === "card" &&
                      "border-[0.7px] border-[hsl(var(--gray-400))] shadow-lg",
                    surface === "canvas" &&
                      "shadow-[0_24px_70px_rgba(0,0,0,0.30)]",
                  ]
                : [
                    "h-full w-full rounded-none",
                    "pt-[var(--sat,env(safe-area-inset-top,0px))]",
                    "pr-[var(--sar,env(safe-area-inset-right,0px))]",
                    "pb-[var(--sab,env(safe-area-inset-bottom,0px))]",
                    "pl-[var(--sal,env(safe-area-inset-left,0px))]",
                  ],
            )}
          >
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div
                data-slot="dialog-inner"
                className={cn(
                  "grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto p-6 dialog-scrollable",
                  contentClassName,
                )}
              >
                {children}
              </div>
              {showCloseButton ? (
                <DialogPrimitive.Close
                  data-slot="dialog-close"
                  render={
                    <button
                      type="button"
                      className="icon-button absolute right-4 top-4 opacity-70 hover:opacity-100"
                      aria-label={closeLabel}
                    />
                  }
                >
                  <X size={20} className="text-foreground" />
                </DialogPrimitive.Close>
              ) : null}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = "DialogContent";

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto", className)}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
