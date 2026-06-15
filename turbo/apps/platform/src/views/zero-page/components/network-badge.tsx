// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function formatSize(bytes: number | undefined | null): string {
  if (bytes === null || bytes === undefined) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Badge component
// ---------------------------------------------------------------------------

const COLOR_MAP = {
  muted: "bg-muted text-muted-foreground",
  warning:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  violet:
    "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  teal: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
  red: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
} as const;

export type BadgeColor = keyof typeof COLOR_MAP;

export function InlineBadge({
  color,
  children,
}: {
  color: BadgeColor;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${COLOR_MAP[color]}`}
    >
      {children}
    </span>
  );
}
