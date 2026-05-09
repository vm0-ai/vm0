/**
 * Mobile-native iOS Settings-style stacked list primitives.
 *
 * Four pages — agent detail, schedule detail, account hub, workspace
 * settings master — used to roll their own variant of the same row /
 * section / list pattern. They've now collapsed into this one component
 * tree so the visual tokens (tinted-square icon, row padding, chevron
 * weight, hover, hairline divider) are guaranteed identical.
 *
 * Pages that need extra surfaces (hero card, primary CTA, section
 * descriptions) wrap these primitives — they're not part of the stack
 * itself, since the four pages all decorate the stack differently.
 */

import type { ReactNode } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { cn } from "@vm0/ui";

interface MobileStackListProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Outer container — vertically stacks multiple `MobileStackSection`s. */
export function MobileStackList({ children, className }: MobileStackListProps) {
  return <div className={cn("flex flex-col gap-6", className)}>{children}</div>;
}

interface MobileStackSectionProps {
  readonly children: ReactNode;
  /** Optional sentence-case label rendered above the card. */
  readonly label?: string;
  readonly className?: string;
}

/**
 * One grouped card. Hairline dividers between consecutive `MobileStackRow`
 * children appear automatically via the `[&>button+button]:border-t`
 * descendant selector — no `isLast` prop needed at the row level.
 */
export function MobileStackSection({
  children,
  label,
  className,
}: MobileStackSectionProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label && (
        <span className="px-1 text-[13px] font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <div className="zero-card overflow-hidden [&>button+button]:border-t [&>button+button]:border-border/50">
        {children}
      </div>
    </div>
  );
}

interface MobileStackRowProps {
  readonly label: string;
  readonly onClick: () => void;
  /** When provided, renders inside a 9x9 tinted squircle (gray-100 / red-100). */
  readonly icon?: ReactNode;
  readonly testId?: string;
  /** Right-side decoration. Defaults to a 18px chevron. Pass null to hide. */
  readonly rightSlot?: ReactNode;
  /** Red label + red icon-square tint (used by destructive items like Sign out). */
  readonly destructive?: boolean;
}

/**
 * Single tappable row. The full surface is a button so the entire row,
 * including the right chevron area, is the touch target — matching iOS
 * Settings behavior.
 */
export function MobileStackRow({
  icon,
  label,
  onClick,
  testId,
  rightSlot,
  destructive,
}: MobileStackRowProps) {
  const trailing =
    rightSlot === undefined ? (
      <IconChevronRight
        size={18}
        stroke={1.5}
        className="shrink-0 text-muted-foreground/50"
      />
    ) : (
      rightSlot
    );
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50 active:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
    >
      {icon && (
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
            destructive
              ? "bg-red-100 text-destructive dark:bg-red-950/40"
              : "bg-gray-100 text-foreground/70",
          )}
        >
          {icon}
        </span>
      )}
      <span
        className={cn(
          "flex-1 min-w-0 truncate text-[16px] font-medium",
          destructive ? "text-destructive" : "text-foreground",
        )}
      >
        {label}
      </span>
      {trailing}
    </button>
  );
}
