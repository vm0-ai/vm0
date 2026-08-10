import { type HTMLAttributes, useEffect, useState } from "react";

import { cn } from "../../lib/utils";

interface AnimatedNumberProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> {
  value: number | null;
  formatValue?: (value: number) => string;
  pendingTargetRange?: readonly [min: number, max: number];
  pendingTickMs?: number;
}

const DEFAULT_PENDING_TARGET_RANGE = [0, 100] as const;
const DEFAULT_PENDING_TICK_MS = 80;
const DECIMAL_DIGIT_PATTERN = /^\p{Decimal_Number}$/u;

function defaultFormatValue(value: number): string {
  return String(value);
}

function AnimatedNumber({
  value,
  formatValue = defaultFormatValue,
  pendingTargetRange = DEFAULT_PENDING_TARGET_RANGE,
  pendingTickMs = DEFAULT_PENDING_TICK_MS,
  className,
  ...props
}: AnimatedNumberProps) {
  const [pendingValue, setPendingValue] = useState(0);
  const [pendingMin, pendingMax] = pendingTargetRange;

  useEffect(() => {
    if (value !== null) {
      return;
    }

    const min = Math.ceil(Math.min(pendingMin, pendingMax));
    const max = Math.floor(Math.max(pendingMin, pendingMax));
    const pendingTarget = Math.max(
      1,
      Math.floor(Math.random() * (max - min + 1)) + min,
    );
    let frameId = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      frameId = window.requestAnimationFrame(() => {
        setPendingValue(pendingTarget);
      });
      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }

    const startedAt = performance.now();
    let lastUpdateAt = startedAt - pendingTickMs;
    const update = (now: DOMHighResTimeStamp) => {
      if (now - lastUpdateAt >= pendingTickMs) {
        const timeUnits = (now - startedAt) / pendingTickMs;
        const progress = Math.log1p(timeUnits) / Math.log(timeUnits + 2);
        const nextValue = Math.min(
          pendingTarget - 1,
          Math.floor(pendingTarget * progress),
        );
        setPendingValue((current) => {
          return current === nextValue ? current : nextValue;
        });
        lastUpdateAt = now;
      }
      frameId = window.requestAnimationFrame(update);
    };
    frameId = window.requestAnimationFrame(update);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [pendingMax, pendingMin, pendingTickMs, value]);

  const displayValue = value ?? pendingValue;
  const formattedValue = formatValue(displayValue);
  const rawCharacters = Array.from(formattedValue);
  const characters = rawCharacters.map((character, index) => {
    const isDigit = DECIMAL_DIGIT_PATTERN.test(character);
    const place = rawCharacters.slice(index + 1).filter((candidate) => {
      return DECIMAL_DIGIT_PATTERN.test(candidate);
    }).length;
    return { character, isDigit, place };
  });

  return (
    <span className={cn("animated-number", className)} {...props}>
      <span className="animated-number-measure" aria-hidden="true">
        {formattedValue}
      </span>
      <span className="animated-number-visual" aria-hidden="true">
        {characters.map(({ character, isDigit, place }) => {
          return (
            <span
              key={`${isDigit ? "digit" : "separator"}-${place}-${character}`}
              className={
                isDigit ? "animated-number-digit" : "animated-number-separator"
              }
            >
              {character}
            </span>
          );
        })}
      </span>
      <span className="sr-only">{formattedValue}</span>
    </span>
  );
}

export { AnimatedNumber, type AnimatedNumberProps };
