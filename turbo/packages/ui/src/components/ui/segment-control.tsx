"use client";

import * as React from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";

type SegmentControlSize = "xs" | "sm" | "default" | "lg";

const SegmentControlSizeContext =
  React.createContext<SegmentControlSize>("default");

/**
 * The track carries the same heights and radius as the rest of the control
 * scale, so a segment control drops into a toolbar next to a button, select,
 * or input without a step. The sizes mirror `buttonVariants` one for one --
 * `xs` h-7, `sm` h-8, `default` h-9 (also Input and SelectTrigger), `lg` h-10
 * -- and every size uses `rounded-lg`.
 *
 * `--muted` is gray-100 in light and gray-200 in dark, which is a recessed
 * step under the selected segment in both themes.
 */
const segmentControlVariants = cva(
  "inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px]",
  {
    variants: {
      size: {
        xs: "h-7",
        sm: "h-8",
        default: "h-9",
        lg: "h-10",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

/**
 * `rounded-[5px]` keeps the segment concentric with the track: the 8px outer
 * radius minus the 3px of track padding it sits inside.
 *
 * The selected segment carries an opaque fill, so it must not take the
 * translucent `state-hover` layer -- the layer replaces a fill instead of
 * sitting on it, which would drop the segment back to the track colour.
 */
const segmentControlItemVariants = cva(
  "inline-flex h-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors select-none not-data-checked:hover:bg-state-hover not-data-checked:hover:text-foreground data-checked:bg-segment-selected data-checked:text-foreground data-checked:shadow-segment-selected data-disabled:pointer-events-none data-disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    // Segment padding runs one step tighter than the matching button size,
    // because the segment already sits inside the track's 3px inset -- that
    // puts the label the same optical distance from the outer edge as a
    // button of the same size. `xs` drops to `text-xs`: 14px text in a 22px
    // segment leaves a 1px line box gap, which reads as clipped.
    variants: {
      size: {
        xs: "px-2 text-xs",
        sm: "px-2.5 text-sm",
        default: "px-3 text-sm",
        lg: "px-5 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

interface SegmentControlProps<Value> extends Omit<
  RadioGroupPrimitive.Props<Value>,
  "className"
> {
  className?: string;
  size?: SegmentControlSize;
}

function SegmentControl<Value>({
  className,
  size = "default",
  ...props
}: SegmentControlProps<Value>) {
  return (
    <SegmentControlSizeContext value={size}>
      <RadioGroupPrimitive
        data-slot="segment-control"
        className={cn(segmentControlVariants({ size }), className)}
        {...props}
      />
    </SegmentControlSizeContext>
  );
}
SegmentControl.displayName = "SegmentControl";

interface SegmentControlItemProps<Value> extends Omit<
  RadioPrimitive.Root.Props<Value>,
  "className"
> {
  className?: string;
}

function SegmentControlItem<Value>({
  className,
  ...props
}: SegmentControlItemProps<Value>) {
  const size = React.useContext(SegmentControlSizeContext);

  return (
    <RadioPrimitive.Root
      data-slot="segment-control-item"
      className={cn(segmentControlItemVariants({ size }), className)}
      {...props}
    />
  );
}
SegmentControlItem.displayName = "SegmentControlItem";

export {
  SegmentControl,
  SegmentControlItem,
  type SegmentControlProps,
  type SegmentControlItemProps,
};
