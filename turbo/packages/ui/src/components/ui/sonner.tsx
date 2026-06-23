import { createPortal } from "react-dom";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const DEFAULT_TOASTER_OFFSET = {
  top: "calc(var(--sat, 0px) + 24px)",
  bottom: "calc(var(--sab, 0px) + 24px)",
} satisfies ToasterProps["offset"];

const DEFAULT_TOASTER_MOBILE_OFFSET = {
  top: "calc(var(--sat, 0px) + 12px)",
  right: "0px",
  bottom: "calc(var(--sab, 0px) + 16px)",
  left: "0px",
} satisfies ToasterProps["mobileOffset"];

function Toaster({ ...props }: ToasterProps) {
  const {
    mobileOffset = DEFAULT_TOASTER_MOBILE_OFFSET,
    offset = DEFAULT_TOASTER_OFFSET,
    style,
    ...rest
  } = props;
  const toaster = (
    <Sonner
      className="toaster group !flex !flex-col !items-center"
      duration={3000}
      mobileOffset={mobileOffset}
      offset={offset}
      style={{
        ...style,
        zIndex: 2147483647,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:!rounded-[10px] group-[.toaster]:!text-sm group-[.toaster]:!font-medium group-[.toaster]:!w-auto group-[.toaster]:!max-w-[calc(100dvw-2rem)] sm:group-[.toaster]:!max-w-none group-[.toaster]:!whitespace-normal sm:group-[.toaster]:!whitespace-nowrap group-[.toaster]:!left-auto group-[.toaster]:!top-auto group-[.toaster]:!relative [&_[data-icon]]:text-green-600 [&[data-type=error]_[data-icon]]:text-red-500",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
        style: {
          fontFamily:
            '"Noto Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      }}
      {...rest}
    />
  );

  if (typeof document === "undefined") {
    return toaster;
  }

  return createPortal(toaster, document.body);
}

export { Toaster, toast };
