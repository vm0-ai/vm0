"use client";

import { Fragment, useState, type ReactElement } from "react";
import { getShortcutLabel } from "../../lib/keyboard-shortcuts";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

interface ShortcutItem {
  readonly shortcut: string;
  readonly trigger: ReactElement<{
    "aria-label": string;
    disabled?: boolean;
  }>;
}

function ShortcutItemTooltip({
  item,
  hintVisible,
}: {
  readonly item: ShortcutItem;
  readonly hintVisible: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={!hintVisible && open}
      onOpenChange={setOpen}
      disabled={item.trigger.props.disabled}
    >
      <TooltipTrigger asChild>{item.trigger}</TooltipTrigger>
      <TooltipContent
        role="tooltip"
        side="bottom"
        className={hintVisible ? "hidden" : undefined}
      >
        {item.trigger.props["aria-label"]}
      </TooltipContent>
    </Tooltip>
  );
}

/** One ordered hint panel per button group, regardless of its button count. */
export function ShortcutTooltipGroup({
  items,
  hintVisible,
}: {
  readonly items: readonly ShortcutItem[];
  readonly hintVisible: boolean;
}) {
  const enabledItems = items.filter((item) => {
    return !item.trigger.props.disabled;
  });

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip
        open={hintVisible && enabledItems.length > 0}
        disableHoverablePopup
      >
        <TooltipTrigger
          render={<span className="inline-flex shrink-0 items-center gap-1" />}
        >
          {items.map((item) => {
            return (
              <ShortcutItemTooltip
                key={item.shortcut}
                item={item}
                hintVisible={hintVisible}
              />
            );
          })}
        </TooltipTrigger>
        <TooltipContent
          role="tooltip"
          side="bottom"
          align="end"
          className={cn(
            "pointer-events-none px-3 py-2",
            !hintVisible && "hidden",
          )}
        >
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2">
            {enabledItems.map((item) => {
              return (
                <Fragment key={item.shortcut}>
                  <dt>{item.trigger.props["aria-label"]}</dt>
                  <dd className="text-right">
                    <kbd className="whitespace-nowrap font-sans text-xs">
                      {getShortcutLabel(item.shortcut)}
                    </kbd>
                  </dd>
                </Fragment>
              );
            })}
          </dl>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
