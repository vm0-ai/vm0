"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "../../lib/utils";

/** Half the thumb, in px. Ticks share it so each mark lands under a stop. */
const THUMB_RADIUS = 7;

interface SliderProps extends Omit<
  SliderPrimitive.Root.Props<number>,
  "className" | "render"
> {
  className?: string;
  /**
   * Draw one mark per step above the track. Use it when the steps are the
   * point — a duration in whole seconds — rather than a continuous range.
   */
  ticks?: boolean;
  /**
   * Names the slider. It lands on the thumb, because that is where Base UI
   * renders the real `input[type=range]` that carries the slider role.
   */
  "aria-label"?: string;
  /** Reads the value as the user's unit rather than as the raw step index. */
  getAriaValueText?: SliderPrimitive.Thumb.Props["getAriaValueText"];
}

function tickCount(min: number, max: number, step: number): number {
  return Math.floor((max - min) / step) + 1;
}

/**
 * A single-value slider on the vm0 ramp: muted track, brand fill, and a thumb
 * that lifts under the pointer.
 *
 * Chrome top-aligns a native range thumb rather than centring it, which is why
 * this is built on the Base UI primitive instead: the thumb is a real element,
 * so it centres on the track by layout rather than by pixel correction.
 */
const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  (
    {
      className,
      ticks = false,
      min = 0,
      max = 100,
      step = 1,
      "aria-label": ariaLabel,
      getAriaValueText,
      ...props
    },
    ref,
  ) => {
    return (
      <SliderPrimitive.Root
        ref={ref}
        data-slot="slider"
        min={min}
        max={max}
        step={step}
        className={cn("flex w-full flex-col gap-1", className)}
        {...props}
      >
        {ticks && (
          <div
            aria-hidden="true"
            className="flex items-end justify-between"
            style={{
              paddingInline: `${String(THUMB_RADIUS)}px`,
            }}
          >
            {Array.from({ length: tickCount(min, max, step) }, (_, index) => {
              return (
                <span
                  key={index}
                  className="h-1 w-px rounded-full bg-gray-400"
                />
              );
            })}
          </div>
        )}
        <SliderPrimitive.Control className="flex h-4 w-full items-center">
          <SliderPrimitive.Track className="h-1.5 w-full rounded-full bg-muted select-none">
            <SliderPrimitive.Indicator className="rounded-full bg-primary select-none" />
            <SliderPrimitive.Thumb
              aria-label={ariaLabel}
              getAriaValueText={getAriaValueText}
              className={cn(
                "size-3.5 rounded-full border border-primary bg-card shadow-sm outline-none",
                "transition-transform duration-150 ease-out select-none",
                "hover:scale-110 data-dragging:scale-125",
                "focus-visible:ring-2 focus-visible:ring-ring",
                "motion-reduce:transition-none",
              )}
            />
          </SliderPrimitive.Track>
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = "Slider";

export { Slider };
