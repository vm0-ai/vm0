import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconClock,
  IconChevronRight,
  IconLoader2,
  IconUsers,
  IconCircleDot,
  IconPlugConnected,
} from "@tabler/icons-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import {
  TRIGGER_SOURCE_LABELS,
  type LogEntry,
  type LogStatus,
} from "../../signals/zero-page/log-types.ts";
import { StatusBadge } from "./components/logs/status-badge.tsx";
import { Pagination } from "../components/pagination.tsx";
import {
  zeroActivityAgentFilter$,
  zeroActivityStatusFilter$,
  zeroActivitySourceFilter$,
  setZeroActivityFilter$,
  zeroActivityData$,
  zeroActivityLimit$,
  zeroActivityHasPrev$,
  zeroActivityCurrentPage$,
  goToNextZeroActivityPage$,
  goToPrevZeroActivityPage$,
  goForwardTwoZeroActivityPages$,
  goBackTwoZeroActivityPages$,
  setZeroActivityRowsPerPage$,
  formatLogTime,
  formatDuration,
  zeroActivityAvailableStatuses$,
  zeroActivityAvailableSources$,
  zeroActivityAvailableAgents$,
} from "../../signals/activity-page/activity-signals.ts";
import { Link } from "../router/link.tsx";
import { Reason, detach } from "../../signals/utils.ts";
import emptyActivityImg from "./assets/empty-activity.webp";

const STATUS_LABELS: Readonly<Record<LogStatus, string>> = {
  queued: "Queued",
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timeout: "Timeout",
  cancelled: "Cancelled",
};

const ROW_GRID =
  "grid grid-cols-[1fr_5rem_1fr_8rem_5rem_2.5rem] gap-x-6 items-center";

function ActivityRow({
  entry,
  logId,
  agentName = "Zero",
}: {
  entry: LogEntry;
  logId: string;
  agentName?: string;
}) {
  const time = formatLogTime(entry.createdAt);
  return (
    <Link
      pathname="/activity/:logId"
      options={{ pathParams: { logId } }}
      className="block py-3 transition-colors hover:bg-muted/50 cursor-pointer border-b border-border/40 last:border-b-0 no-underline text-inherit"
    >
      <div className={cn(ROW_GRID)}>
        <div className="min-w-0 truncate text-left text-sm font-medium text-foreground">
          {agentName}
        </div>
        <div className="text-left text-sm text-muted-foreground">
          {entry.triggerSource
            ? TRIGGER_SOURCE_LABELS[entry.triggerSource]
            : "—"}
        </div>
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
              {formatDuration(entry.startedAt, entry.completedAt) ?? "—"}
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

export function ZeroActivityPage() {
  const dataLoadable = useLoadable(zeroActivityData$);
  const hasPrev = useGet(zeroActivityHasPrev$);
  const currentPage = useGet(zeroActivityCurrentPage$);
  const rowsPerPage = useGet(zeroActivityLimit$);
  const goToNext = useSet(goToNextZeroActivityPage$);
  const goToPrev = useSet(goToPrevZeroActivityPage$);
  const goForwardTwo = useSet(goForwardTwoZeroActivityPages$);
  const goBackTwo = useSet(goBackTwoZeroActivityPages$);
  const setRowsPerPage = useSet(setZeroActivityRowsPerPage$);

  const agentFilter = useGet(zeroActivityAgentFilter$);
  const statusFilter = useGet(zeroActivityStatusFilter$);
  const sourceFilter = useGet(zeroActivitySourceFilter$);
  const setFilter = useSet(setZeroActivityFilter$);
  const availableStatusesLoadable = useLoadable(zeroActivityAvailableStatuses$);
  const availableSourcesLoadable = useLoadable(zeroActivityAvailableSources$);
  const availableAgentsLoadable = useLoadable(zeroActivityAvailableAgents$);

  const logs = dataLoadable.state === "hasData" ? dataLoadable.data.data : [];
  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const totalPages =
    dataLoadable.state === "hasData"
      ? dataLoadable.data.pagination.totalPages
      : undefined;
  const isLoading = dataLoadable.state === "loading";

  // Agent filter options: only agents with activity records
  const agentOptions = [
    { value: "all", label: "All agents" },
    ...(availableAgentsLoadable.state === "hasData"
      ? availableAgentsLoadable.data.map((a) => ({
          value: a.name,
          label: a.displayName,
        }))
      : []),
  ];

  const statusOptions = [
    { value: "all", label: "All status" },
    ...(availableStatusesLoadable.state === "hasData"
      ? availableStatusesLoadable.data.map((s) => ({
          value: s,
          label: STATUS_LABELS[s],
        }))
      : []),
  ];

  const sourceOptions = [
    { value: "all", label: "All sources" },
    ...(availableSourcesLoadable.state === "hasData"
      ? availableSourcesLoadable.data.map((s) => ({
          value: s,
          label: TRIGGER_SOURCE_LABELS[s],
        }))
      : []),
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Fixed header: title + filters */}
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Activity
              </h1>
              <p className="text-sm text-muted-foreground">
                Logs and runs from your agents.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={agentFilter}
                onValueChange={(v) => setFilter("agent", v)}
              >
                <SelectTrigger className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium">
                  <IconUsers size={14} stroke={1.5} className="shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={(v) => setFilter("status", v)}
              >
                <SelectTrigger className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium">
                  <IconCircleDot size={14} stroke={1.5} className="shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={sourceFilter}
                onValueChange={(v) => setFilter("source", v)}
              >
                <SelectTrigger className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium">
                  <IconPlugConnected
                    size={14}
                    stroke={1.5}
                    className="shrink-0"
                  />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      {/* Scrollable table area */}
      <div className="flex-1 min-h-0 overflow-auto px-4 sm:px-6 pt-4">
        <div className="mx-auto max-w-[900px]">
          <div className="zero-card overflow-hidden px-4 sm:px-7 pb-3">
            <div className="overflow-x-auto">
              <div className="min-w-[540px]">
                {(logs.length > 0 || isLoading) && (
                  <div
                    className={cn(
                      ROW_GRID,
                      "sticky top-0 z-10 py-3 text-sm font-medium text-muted-foreground bg-card border-b border-border/40",
                    )}
                  >
                    <div className="text-left">Agent</div>
                    <div className="text-left">Source</div>
                    <div className="text-left">Status</div>
                    <div className="text-left">Start Time</div>
                    <div className="text-left">Duration</div>
                    <div />
                  </div>
                )}
                {isLoading ? (
                  <div className="flex items-center justify-center min-h-[20rem]">
                    <IconLoader2
                      size={20}
                      stroke={1.5}
                      className="animate-spin text-muted-foreground"
                    />
                  </div>
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
                        {agentFilter === "all" &&
                        statusFilter === "all" &&
                        sourceFilter === "all"
                          ? "All quiet for now"
                          : "Nothing matches those filters"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {agentFilter === "all" &&
                        statusFilter === "all" &&
                        sourceFilter === "all"
                          ? "When your agents start working, their activity will show up here."
                          : "Try different filters to find what you're looking for."}
                      </p>
                    </div>
                  </div>
                ) : (
                  logs.map((entry) => (
                    <ActivityRow
                      key={entry.id}
                      entry={entry}
                      logId={entry.id}
                      agentName={entry.displayName ?? entry.agentName}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Fixed pagination footer — hidden when everything fits on one page */}
      {(totalPages === undefined || totalPages > 1) && (
        <div className="shrink-0 px-4 sm:px-6 py-4">
          <div className="mx-auto max-w-[900px]">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              rowsPerPage={rowsPerPage}
              hasNext={hasNext}
              hasPrev={hasPrev}
              isLoading={isLoading}
              labelClassName="font-normal text-muted-foreground"
              buttonClassName="bg-transparent border-border/70"
              onNextPage={() => detach(goToNext(), Reason.DomCallback)}
              onPrevPage={() => goToPrev()}
              onForwardTwoPages={() =>
                detach(goForwardTwo(), Reason.DomCallback)
              }
              onBackTwoPages={() => goBackTwo()}
              onRowsPerPageChange={(limit) => setRowsPerPage(limit)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
