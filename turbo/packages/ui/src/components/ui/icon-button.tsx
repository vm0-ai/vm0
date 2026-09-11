import * as React from "react";

import { cn } from "../../lib/utils";
import {
  ButtonBase,
  type ButtonBaseProps,
  type ButtonTooltipOptions,
} from "./button-base";

export type IconButtonProps = Omit<
  ButtonBaseProps,
  "showTooltip" | "tooltipFullWidth"
> &
  ButtonTooltipOptions & { "aria-label": string };

/** A neutral square control whose icon and foreground come from its caller. */
const IconButton = React.forwardRef<HTMLElement, IconButtonProps>(
  ({ className, ...props }, ref) => {
    return (
      <ButtonBase
        data-slot="icon-button"
        {...props}
        ref={ref}
        className={cn(
          "flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
          className,
        )}
      />
    );
  },
);
IconButton.displayName = "IconButton";

export { IconButton };
