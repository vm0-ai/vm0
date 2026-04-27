import { IconPencil } from "@tabler/icons-react";

export type SessionIndicatorState = "running" | "unread" | "draft" | "none";

/**
 * Visual indicator for chat session state in the sidebar.
 *
 * Three states differentiated by *shape* (not just color) so they remain
 * distinguishable for color-blind users and in static screenshots:
 * - running: spinning arc — open shape, conveys in-progress
 * - unread:  solid filled dot, optional count badge
 * - draft:   pencil outline icon
 *
 * Stacking priority: running > unread > draft. Callers resolve to a single
 * state before rendering — the component itself only renders the one passed in.
 */
export function SessionIndicator({
  state,
  unreadCount,
}: {
  state: SessionIndicatorState;
  unreadCount?: number;
}) {
  if (state === "running") {
    return (
      <span
        className="shrink-0 h-3.5 w-3.5 rounded-full border-[1.8px] border-emerald-500/25 border-t-emerald-500 border-r-emerald-500 animate-spin"
        style={{ boxShadow: "0 0 6px rgba(16, 185, 129, 0.25)" }}
        role="status"
        aria-label="Running"
      />
    );
  }

  if (state === "unread") {
    if (unreadCount && unreadCount > 0) {
      const label = unreadCount > 99 ? "99+" : String(unreadCount);
      return (
        <span
          className="shrink-0 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-none text-primary-foreground"
          aria-label={`${unreadCount} unread`}
        >
          {label}
        </span>
      );
    }
    return (
      <span
        className="shrink-0 h-2 w-2 rounded-full bg-primary"
        aria-label="Unread"
      />
    );
  }

  if (state === "draft") {
    return (
      <IconPencil
        size={14}
        stroke={2.2}
        className="shrink-0 text-muted-foreground"
        aria-label="Draft"
      />
    );
  }

  return null;
}
