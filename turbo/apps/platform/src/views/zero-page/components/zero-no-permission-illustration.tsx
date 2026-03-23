import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@vm0/ui";

type Props = ComponentPropsWithoutRef<"svg">;

/**
 * Decorative lock mark for “no access” / not-found empty states (transparent
 * background, theme-aware stroke).
 */
export function ZeroNoPermissionIllustration({ className, ...rest }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 96 96"
      fill="none"
      className={cn(
        "h-24 w-auto max-w-[200px] shrink-0 opacity-90 text-muted-foreground",
        className,
      )}
      aria-hidden
      {...rest}
    >
      <path
        d="M64 44H32c-3.3 0-6 2.7-6 6v28c0 3.3 2.7 6 6h32c3.3 0 6-2.7 6-6V50c0-3.3-2.7-6-6-6Z"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path
        d="M38 44V34c0-8.8 7.2-16 16-16s16 7.2 16 16v10"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="48" cy="64" r="4" fill="currentColor" />
    </svg>
  );
}
