import { IconChevronRight, IconClock, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import { useTranslation } from "react-i18next";
import {
  getTriggerSourceLabel,
  type LogEntry,
} from "../../../../signals/zero-page/log-types.ts";
import {
  formatLogTime,
  formatDuration,
} from "../../../../signals/activity-page/activity-signals.ts";
import { StatusBadge } from "./status-badge.tsx";
import { Link } from "../../../router/link.tsx";
import { emptyActivityImg } from "../../platform-assets.ts";

// ---------------------------------------------------------------------------
// Grid layouts
// ---------------------------------------------------------------------------

/** With source column (activity page) */
const GRID_WITH_SOURCE =
  "grid grid-cols-[minmax(6rem,1fr)_minmax(8rem,1.5fr)_minmax(4rem,0.8fr)_6rem_8rem_5rem_2.5rem] gap-x-6 items-center";

/** Without source column (automation history) */
const GRID_WITHOUT_SOURCE =
  "grid grid-cols-[1fr_1fr_8rem_5rem_2.5rem] gap-x-6 items-center";

/** Without source, with description column (cross-automation run history) */
const GRID_WITH_DESCRIPTION =
  "grid grid-cols-[minmax(6rem,1fr)_minmax(8rem,2fr)_6rem_8rem_5rem_2.5rem] gap-x-6 items-center";

function pickGrid(showSource: boolean, showDescription: boolean): string {
  if (showSource) {
    return GRID_WITH_SOURCE;
  }
  if (showDescription) {
    return GRID_WITH_DESCRIPTION;
  }
  return GRID_WITHOUT_SOURCE;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function LogRow({
  entry,
  showSource,
  showDescription,
  gridClassName,
}: {
  entry: LogEntry;
  showSource: boolean;
  showDescription: boolean;
  gridClassName: string;
}) {
  const { t } = useTranslation();
  const time = formatLogTime(entry.createdAt);
  const agentName = entry.displayName ?? entry.agentId;

  return (
    <Link
      pathname="/activities/:activityRunId"
      options={{ pathParams: { activityRunId: entry.id } }}
      className="block px-5 py-3 transition-colors hover:bg-muted/50 cursor-pointer border-b border-border/40 last:border-b-0 no-underline text-inherit"
    >
      <div className={cn(gridClassName)}>
        <div className="min-w-0 truncate text-left text-sm font-medium text-foreground">
          {agentName}
        </div>
        {showDescription && (
          <div
            className="min-w-0 truncate text-left text-sm text-muted-foreground"
            title={entry.prompt}
          >
            {entry.prompt.trim() || "\u2014"}
          </div>
        )}
        {showSource && (
          <div className="text-left text-sm text-muted-foreground truncate">
            {entry.triggerSource
              ? getTriggerSourceLabel(
                  entry.triggerSource,
                  entry.triggerAgentName,
                )
              : "\u2014"}
          </div>
        )}
        {showSource && (
          <div
            className="min-w-0 truncate text-left text-sm text-muted-foreground font-mono"
            title={entry.sessionId ?? undefined}
          >
            {entry.sessionId ? entry.sessionId.slice(0, 8) : "\u2014"}
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
            <span
              className="inline-flex items-center gap-1"
              data-testid="duration-running"
            >
              <IconLoader2
                size={12}
                stroke={1.5}
                className="animate-spin"
                aria-label={t(($) => {
                  return $.activity.statuses.running;
                })}
              />
              {t(($) => {
                return $.activity.statuses.running;
              })}
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
  showDescription,
  gridClassName,
}: {
  count: number;
  showSource: boolean;
  showDescription: boolean;
  gridClassName: string;
}) {
  return (
    <div className="divide-y divide-border/40">
      {Array.from({ length: count }, (_, i) => {
        return (
          <div key={i} className={cn(gridClassName, "px-5 py-3")}>
            <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
            {showDescription && (
              <div className="h-4 w-40 rounded bg-muted/50 animate-pulse" />
            )}
            {showSource && (
              <div className="h-4 w-12 rounded bg-muted/50 animate-pulse" />
            )}
            {showSource && (
              <div className="h-4 w-14 rounded bg-muted/50 animate-pulse" />
            )}
            <div className="h-5 w-16 rounded-full bg-muted/50 animate-pulse" />
            <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
            <div className="h-4 w-14 rounded bg-muted/50 animate-pulse" />
            <div />
          </div>
        );
      })}
    </div>
  );
}

function LogTableHeader({
  gridClassName,
  showDescription,
  showSource,
}: {
  gridClassName: string;
  showDescription: boolean;
  showSource: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        gridClassName,
        "sticky top-0 z-10 px-5 py-3 text-sm font-medium text-muted-foreground bg-card border-b border-border/40",
      )}
    >
      <div className="text-left">
        {t(($) => {
          return $.activity.table.headers.agent;
        })}
      </div>
      {showDescription && (
        <div className="text-left">
          {t(($) => {
            return $.activity.table.headers.description;
          })}
        </div>
      )}
      {showSource && (
        <div className="text-left">
          {t(($) => {
            return $.activity.table.headers.source;
          })}
        </div>
      )}
      {showSource && (
        <div className="text-left">
          {t(($) => {
            return $.activity.table.headers.session;
          })}
        </div>
      )}
      <div className="text-left">
        {t(($) => {
          return $.activity.table.headers.status;
        })}
      </div>
      <div className="text-left">
        {t(($) => {
          return $.activity.table.headers.startTime;
        })}
      </div>
      <div className="text-left">
        {t(($) => {
          return $.activity.table.headers.duration;
        })}
      </div>
      <div />
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
  /** Show the "Description" column (from the run's prompt). Default: false */
  showDescription?: boolean;
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
  showDescription = false,
  emptyTitle,
  emptyDescription,
  filteredEmptyTitle,
  filteredEmptyDescription,
  hasActiveFilter = false,
  minWidth = "540px",
}: LogTableProps) {
  const { t } = useTranslation();
  const gridClassName = pickGrid(showSource, showDescription);
  const resolvedEmptyTitle =
    emptyTitle ??
    t(($) => {
      return $.activity.table.empty.title;
    });
  const resolvedEmptyDescription =
    emptyDescription ??
    t(($) => {
      return $.activity.table.empty.description;
    });
  const resolvedFilteredEmptyTitle =
    filteredEmptyTitle ??
    t(($) => {
      return $.activity.table.filteredEmpty.title;
    });
  const resolvedFilteredEmptyDescription =
    filteredEmptyDescription ??
    t(($) => {
      return $.activity.table.filteredEmpty.description;
    });

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth }}>
        {(logs.length > 0 || isLoading) && (
          <LogTableHeader
            gridClassName={gridClassName}
            showDescription={showDescription}
            showSource={showSource}
          />
        )}
        {isLoading ? (
          <SkeletonRows
            count={rowsPerPage}
            showSource={showSource}
            showDescription={showDescription}
            gridClassName={gridClassName}
          />
        ) : logs.length === 0 ? (
          <div
            data-testid={
              hasActiveFilter ? "filtered-empty-state" : "empty-state"
            }
            className="flex flex-col items-center justify-center min-h-[20rem] gap-4"
          >
            <img
              src={emptyActivityImg}
              alt=""
              loading="lazy"
              className="h-20 w-20 object-contain opacity-80"
            />
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {hasActiveFilter
                  ? resolvedFilteredEmptyTitle
                  : resolvedEmptyTitle}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {hasActiveFilter
                  ? resolvedFilteredEmptyDescription
                  : resolvedEmptyDescription}
              </p>
            </div>
          </div>
        ) : (
          logs.map((entry) => {
            return (
              <LogRow
                key={entry.id}
                entry={entry}
                showSource={showSource}
                showDescription={showDescription}
                gridClassName={gridClassName}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
