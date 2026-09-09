import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

// Action and toggle buttons share typography, radius and keyboard focus.
// Their layout, selected treatment and disabled appearance remain independent.
export const buttonBaseClassName =
  "rounded-lg text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export type ButtonTooltipOptions =
  | { showTooltip: true; "aria-label": string }
  | { showTooltip?: false };

interface ButtonTooltipProps {
  children: ReactElement;
  label: ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
}

export function ButtonTooltip({
  children,
  label,
  disabled,
  fullWidth = false,
}: ButtonTooltipProps) {
  const trigger = disabled ? (
    <span className={cn("inline-flex", fullWidth && "w-full")}>{children}</span>
  ) : (
    children
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent>
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
