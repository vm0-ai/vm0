import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconClock,
  IconChevronRight,
  IconLoader2,
} from "@tabler/icons-react";
import { Button, Input, cn } from "@vm0/ui";
import type { LogStatus, LogEntry } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import { ZeroActivityDetailPage } from "./zero-activity-detail-page.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroActivityLogs$,
  zeroActivitySearch$,
  setZeroActivitySearch$,
  zeroActivityHasMore$,
  zeroActivityLoading$,
  fetchZeroActivityLogs$,
  loadMoreZeroActivityLogs$,
  zeroActivitySelectedLogId$,
  setZeroActivitySelectedLogId$,
  logStatusToActivityStatus,
  formatLogTime,
} from "../../signals/zero-page/zero-activity.ts";
import { Reason, detach } from "../../signals/utils.ts";

function activityStatusToLogStatus(
  status: "success" | "error" | "warning" | "running",
): LogStatus {
  switch (status) {
    case "success": {
      return "completed";
    }
    case "error": {
      return "failed";
    }
    case "warning": {
      return "timeout";
    }
    case "running": {
      return "running";
    }
  }
}

const ROW_GRID =
  "grid grid-cols-[5rem_1fr_1fr_1fr_2.5rem] gap-x-6 items-center";

function ActivityRow({
  entry,
  onSelect,
  agentName = "Zero",
}: {
  entry: LogEntry;
  onSelect: (id: string) => void;
  agentName?: string;
}) {
  const status = logStatusToActivityStatus(entry.status);
  const time = formatLogTime(entry.createdAt);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onSelect(entry.id);
        }
      }}
      className="py-3 rounded-r-sm transition-colors hover:bg-muted/20 cursor-pointer"
    >
      <div className={cn(ROW_GRID)}>
        <div className="text-left text-sm text-muted-foreground tabular-nums">
          {time}
        </div>
        <div className="min-w-0 truncate text-left text-sm text-foreground">
          {agentName}
        </div>
        <div className="text-left">
          <StatusBadge status={activityStatusToLogStatus(status)} zeroStyle />
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
              {entry.status}
            </span>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(entry.id);
            }}
            className="rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors"
            aria-label="View details"
          >
            <IconChevronRight size={14} stroke={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ZeroActivityPage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";

  const logs = useGet(zeroActivityLogs$);
  const search = useGet(zeroActivitySearch$);
  const setSearch = useSet(setZeroActivitySearch$);
  const hasMore = useGet(zeroActivityHasMore$);
  const loading = useGet(zeroActivityLoading$);
  const fetchLogs = useSet(fetchZeroActivityLogs$);
  const loadMore = useSet(loadMoreZeroActivityLogs$);
  const selectedLogId = useGet(zeroActivitySelectedLogId$);
  const setSelectedLogId = useSet(setZeroActivitySelectedLogId$);

  // Initial fetch on mount
  const initialized$ = useLoadable(zeroActivityLogs$);
  if (initialized$.state === "loading" && logs.length === 0) {
    detach(fetchLogs(), Reason.DomCallback);
  }

  if (selectedLogId) {
    return (
      <ZeroActivityDetailPage
        logId={selectedLogId}
        onBack={() => setSelectedLogId(null)}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Activity
            </h1>
            <p className="text-sm text-muted-foreground">
              Logs and runs from {agentName} and your workflows.
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="relative flex-1">
              <IconSearch
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                size={16}
                stroke={1.5}
              />
              <Input
                placeholder="Search logs..."
                value={search}
                onChange={(e) =>
                  detach(setSearch(e.target.value), Reason.DomCallback)
                }
                className="zero-search-input pl-9 h-9 rounded-lg border"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-2 pb-8">
        <div className="mx-auto max-w-[900px]">
          {logs.length > 0 && (
            <div>
              <div
                className={cn(
                  ROW_GRID,
                  "zero-activity-header py-2 pb-1.5 border-b text-sm font-medium text-muted-foreground",
                )}
              >
                <div className="text-left">Time</div>
                <div className="text-left">Agent</div>
                <div className="text-left">Status</div>
                <div className="text-left">Info</div>
                <div />
              </div>
            </div>
          )}
          {logs.map((entry) => (
            <ActivityRow
              key={entry.id}
              entry={entry}
              onSelect={setSelectedLogId}
              agentName={agentName}
            />
          ))}
          {logs.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No activity found.
            </p>
          )}
          {loading && (
            <div className="flex justify-center py-8">
              <IconLoader2
                size={20}
                stroke={1.5}
                className="animate-spin text-muted-foreground"
              />
            </div>
          )}
          {hasMore && !loading && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => detach(loadMore(), Reason.DomCallback)}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
