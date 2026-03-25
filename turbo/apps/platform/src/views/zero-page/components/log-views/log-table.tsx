import { IconChevronRight, IconClock, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import {
  TRIGGER_SOURCE_LABELS,
  type LogEntry,
  type LogStatus,
} from "../../../../signals/zero-page/log-types.ts";
import {
  formatLogTime,
  formatDuration,
} from "../../../../signals/activity-page/activity-signals.ts";
import { StatusBadge } from "./status-badge.tsx";
import { Link } from "../../../router/link.tsx";
import emptyActivityImg from "../../assets/empty-activity.webp";

export const STATUS_LABELS: Readonly<Record<LogStatus, string>> = {
  queued: "Queued",
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timeout: "Timeout",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Grid layouts
// ---------------------------------------------------------------------------

/** With source column (activity page) */
const GRID_WITH_SOURCE =
  "grid grid-cols-[1fr_5rem_1fr_8rem_5rem_2.5rem] gap-x-6 items-center";

/** Without source column (schedule history) */
const GRID_WITHOUT_SOURCE =
  "grid grid-cols-[1fr_1fr_8rem_5rem_2.5rem] gap-x-6 items-center";

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function LogRow({
  entry,
  showSource,
  gridClassName,
}: {
  entry: LogEntry;
  showSource: boolean;
  gridClassName: string;
}) {
  const time = formatLogTime(entry.createdAt);
  const agentName = entry.displayName ?? entry.agentName;

  return (
    <Link
      pathname="/activity/:logId"
      options={{ pathParams: { logId: entry.id } }}
      className="block py-3 transition-colors hover:bg-muted/50 cursor-pointer border-b border-border/40 last:border-b-0 no-underline text-inherit"
    >
      <div className={cn(gridClassName)}>
        <div className="min-w-0 truncate text-left text-sm font-medium text-foreground">
          {agentName}
        </div>
        {showSource && (
          <div className="text-left text-sm text-muted-foreground">
            {entry.triggerSource
              ? TRIGGER_SOURCE_LABELS[entry.triggerSource]
              : "\u2014"}
          </div>
        )}
        <div className="text-left">
          <StatusBadge status={entry.status} zeroStyle />
        </div>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {time}
        </div>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {entry.status === "running" ? (
            <span className="inline-flex items-center gap-1">
              <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
              Running
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5">
              <IconClock size={12} stroke={1.5} />
              {formatDuration(entry.startedAt, entry.completedAt) ?? "\u2014"}
            </span>
          )}
        </div>
        <div>
          <span
            className="rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors inline-flex"
            aria-hidden="true"
          >
            <IconChevronRight size={14} stroke={1.5} />
          </span>
        </div>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function SkeletonRows({
  count,
  showSource,
  gridClassName,
}: {
  count: number;
  showSource: boolean;
  gridClassName: string;
}) {
  return (
    <div className="divide-y divide-border/40">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn(gridClassName, "py-3")}>
          <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
          {showSource && (
            <div className="h-4 w-12 rounded bg-muted/50 animate-pulse" />
          )}
          <div className="h-5 w-16 rounded-full bg-muted/50 animate-pulse" />
          <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
          <div className="h-4 w-14 rounded bg-muted/50 animate-pulse" />
          <div />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogTable
// ---------------------------------------------------------------------------

interface LogTableProps {
  logs: LogEntry[];
  isLoading: boolean;
  rowsPerPage: number;
  /** Show the "Source" column. Default: false */
  showSource?: boolean;
  /** Empty state text when no filters active */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Empty state text when filters are active */
  filteredEmptyTitle?: string;
  filteredEmptyDescription?: string;
  /** Whether any filter is active (controls which empty message to show) */
  hasActiveFilter?: boolean;
  /** Minimum width of the inner table area */
  minWidth?: string;
}

export function LogTable({
  logs,
  isLoading,
  rowsPerPage,
  showSource = false,
  emptyTitle = "All quiet for now",
  emptyDescription = "When your agents start working, their activity will show up here.",
  filteredEmptyTitle = "Nothing matches those filters",
  filteredEmptyDescription = "Try different filters to find what you're looking for.",
  hasActiveFilter = false,
  minWidth = "540px",
}: LogTableProps) {
  const gridClassName = showSource ? GRID_WITH_SOURCE : GRID_WITHOUT_SOURCE;

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth }}>
        {(logs.length > 0 || isLoading) && (
          <div
            className={cn(
              gridClassName,
              "sticky top-0 z-10 py-3 text-sm font-medium text-muted-foreground bg-card border-b border-border/40",
            )}
          >
            <div className="text-left">Agent</div>
            {showSource && <div className="text-left">Source</div>}
            <div className="text-left">Status</div>
            <div className="text-left">Start Time</div>
            <div className="text-left">Duration</div>
            <div />
          </div>
        )}
        {isLoading ? (
          <SkeletonRows
            count={rowsPerPage}
            showSource={showSource}
            gridClassName={gridClassName}
          />
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[20rem] gap-4">
            <img
              src={emptyActivityImg}
              alt=""
              loading="lazy"
              className="h-20 w-20 object-contain opacity-80"
            />
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {hasActiveFilter ? filteredEmptyTitle : emptyTitle}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {hasActiveFilter ? filteredEmptyDescription : emptyDescription}
              </p>
            </div>
          </div>
        ) : (
          logs.map((entry) => (
            <LogRow
              key={entry.id}
              entry={entry}
              showSource={showSource}
              gridClassName={gridClassName}
            />
          ))
        )}
      </div>
    </div>
  );
}
