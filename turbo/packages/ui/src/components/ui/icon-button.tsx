import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/** Native icon control for dialog and sheet chrome; callers own the glyph and label. */
export function IconButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="icon-button"
      {...props}
      className={cn(
        "flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
        className,
      )}
    />
  );
}
