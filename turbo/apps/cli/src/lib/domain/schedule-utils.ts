/**
 * Format a date string as relative time (e.g., "in 2h", "3d ago")
 */
export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffAbs = Math.abs(diffMs);

  const minutes = Math.floor(diffAbs / (1000 * 60));
  const hours = Math.floor(diffAbs / (1000 * 60 * 60));
  const days = Math.floor(diffAbs / (1000 * 60 * 60 * 24));

  const isPast = diffMs < 0;

  if (days > 0) {
    return isPast ? `${days}d ago` : `in ${days}d`;
  } else if (hours > 0) {
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  } else if (minutes > 0) {
    return isPast ? `${minutes}m ago` : `in ${minutes}m`;
  } else {
    return isPast ? "just now" : "soon";
  }
}
