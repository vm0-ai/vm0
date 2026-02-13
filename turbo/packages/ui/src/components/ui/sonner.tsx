import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group !flex !flex-col !items-center"
      duration={3000}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:!rounded-[10px] group-[.toaster]:!text-sm group-[.toaster]:!font-medium group-[.toaster]:!w-auto group-[.toaster]:!whitespace-nowrap group-[.toaster]:!left-auto group-[.toaster]:!top-auto group-[.toaster]:!relative [&_[data-icon]]:text-green-600",
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
      {...props}
    />
  );
}

export { Toaster, toast };
