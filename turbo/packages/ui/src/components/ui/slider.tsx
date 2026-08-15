"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "../../lib/utils";

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
  /**
   * Reads the value as the user's unit rather than as the raw step index. Pass
   * the already-resolved text; a caller that maps the index back to its own
   * unit would have to answer for an index the slider's own min/max prevent.
   */
  "aria-valuetext"?: string;
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
      "aria-valuetext": ariaValueText,
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
          // Positioned the way the primitive positions its thumb —
          // `insetInlineStart` at the value percentage with a half-width pull
          // back. Laying the marks out with `justify-between` inside a padded
          // row looked right but sat half a thumb off every real stop.
          <div aria-hidden="true" className="relative h-1 w-full">
            {Array.from({ length: tickCount(min, max, step) }, (_, index) => {
              return (
                <span
                  key={index}
                  className="absolute bottom-0 h-1 w-px -translate-x-1/2 rounded-full bg-gray-400"
                  style={{
                    insetInlineStart: `${String(
                      (index / (tickCount(min, max, step) - 1)) * 100,
                    )}%`,
                  }}
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
              aria-valuetext={ariaValueText}
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
