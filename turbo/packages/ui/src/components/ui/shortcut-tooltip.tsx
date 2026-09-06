"use client";

import { useState, type ComponentProps, type ReactElement } from "react";
import { getShortcutLabel } from "../../lib/keyboard-shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export function ShortcutTooltip({
  children,
  shortcut,
  hintVisible,
  side = "bottom",
  hintSide = side,
}: {
  readonly children: ReactElement<{
    "aria-label": string;
    disabled?: boolean;
  }>;
  readonly shortcut: string;
  readonly hintVisible: boolean;
  readonly side?: ComponentProps<typeof TooltipContent>["side"];
  readonly hintSide?: ComponentProps<typeof TooltipContent>["side"];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={hintVisible || open}
      onOpenChange={setOpen}
      disabled={children.props.disabled}
      disableHoverablePopup={hintVisible}
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        role="tooltip"
        side={hintVisible ? hintSide : side}
        className={hintVisible ? "pointer-events-none" : undefined}
      >
        {hintVisible ? (
          <kbd className="whitespace-nowrap font-sans text-xs">
            {getShortcutLabel(shortcut)}
          </kbd>
        ) : (
          <p className="text-xs">{children.props["aria-label"]}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
