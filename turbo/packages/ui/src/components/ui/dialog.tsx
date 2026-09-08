"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import {
  asChildRender,
  type LegacyAutoFocusHandler,
  withLegacyAutoFocus,
} from "../../lib/base-ui-compat";
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
        "okou-dialog-overlay fixed inset-0 bg-overlay/45 dark:bg-overlay/55",
        className,
      )}
      {...props}
    />
  );
});
DialogOverlay.displayName = "DialogOverlay";

interface DialogContentProps extends DialogPrimitive.Popup.Props {
  readonly closeLabel?: string;
  readonly onCloseAutoFocus?: LegacyAutoFocusHandler;
  readonly onOpenAutoFocus?: LegacyAutoFocusHandler;
  readonly overlayClassName?: string;
  readonly showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      children,
      className,
      closeLabel = "Close",
      finalFocus,
      initialFocus,
      onCloseAutoFocus,
      onOpenAutoFocus,
      overlayClassName,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => {
    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} forceRender />
        <DialogPrimitive.Popup
          ref={ref}
          data-slot="dialog-content"
          className={cn(
            "okou-dialog-content fixed left-[50%] top-[50%] grid max-h-[90vh] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-xl border-[0.7px] border-[hsl(var(--gray-400))] bg-card p-6 shadow-lg outline-none dialog-scrollable",
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
        </DialogPrimitive.Popup>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = "DialogContent";

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
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
