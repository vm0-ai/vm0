import type { ComponentPropsWithRef, ReactElement } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";

export function IconTooltip({
  children,
}: {
  readonly children: ReactElement<{
    "aria-label": string;
    disabled?: boolean;
  }>;
}) {
  const trigger = children.props.disabled ? (
    <span className="inline-flex">{children}</span>
  ) : (
    children
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger className="icon-tooltip-trigger" render={trigger} />
        <TooltipContent side="top">
          <p className="text-xs">{children.props["aria-label"]}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type IconTooltipButtonProps = ComponentPropsWithRef<"button"> & {
  readonly "aria-label": string;
};

export function IconTooltipButton({
  children,
  ref,
  ...props
}: IconTooltipButtonProps) {
  return (
    <IconTooltip>
      <button ref={ref} {...props}>
        {children}
      </button>
    </IconTooltip>
  );
}
