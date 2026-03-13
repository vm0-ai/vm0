import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconFilter,
  IconClock,
  IconChevronRight,
  IconLoader2,
} from "@tabler/icons-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import type { LogEntry } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import { Pagination } from "../components/pagination.tsx";
import { ZeroActivityDetailPage } from "./zero-activity-detail-page.tsx";
import {
  zeroActivityAgentFilter$,
  zeroActivityStatusFilter$,
  zeroActivityOrgAgents$,
  setZeroActivityFilter$,
  zeroActivityData$,
  zeroActivityLimit$,
  zeroActivityHasPrev$,
  zeroActivityCurrentPage$,
  syncZeroActivitySub$,
  goToNextZeroActivityPage$,
  goToPrevZeroActivityPage$,
  goForwardTwoZeroActivityPages$,
  goBackTwoZeroActivityPages$,
  setZeroActivityRowsPerPage$,
  formatLogTime,
  formatDuration,
} from "../../signals/zero-page/zero-activity.ts";
import { zeroTabSub$ } from "../../signals/zero-page/zero-nav.ts";
import { updatePathname$ } from "../../signals/route.ts";
import { Reason, detach } from "../../signals/utils.ts";

const STATUS_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "all", label: "All Status" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "timeout", label: "Timeout" },
  { value: "cancelled", label: "Cancelled" },
];

const ROW_GRID =
  "grid grid-cols-[1fr_1fr_8rem_5rem_2.5rem] gap-x-6 items-center";

function ActivityRow({
  entry,
  onSelect,
  agentName = "Zero",
}: {
  entry: LogEntry;
  onSelect: (id: string) => void;
  agentName?: string;
}) {
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
        <div className="min-w-0 truncate text-left text-sm text-foreground">
          {agentName}
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
  const dataLoadable = useLoadable(zeroActivityData$);
  const hasPrev = useGet(zeroActivityHasPrev$);
  const currentPage = useGet(zeroActivityCurrentPage$);
  const rowsPerPage = useGet(zeroActivityLimit$);
  const navigate = useSet(updatePathname$);
  const goToNext = useSet(goToNextZeroActivityPage$);
  const goToPrev = useSet(goToPrevZeroActivityPage$);
  const goForwardTwo = useSet(goForwardTwoZeroActivityPages$);
  const goBackTwo = useSet(goBackTwoZeroActivityPages$);
  const setRowsPerPage = useSet(setZeroActivityRowsPerPage$);

  // URL-driven detail: /zero/activity/:logId
  const sub = useGet(zeroTabSub$);
  const syncSub = useSet(syncZeroActivitySub$);
  syncSub();

  const agentFilter = useGet(zeroActivityAgentFilter$);
  const statusFilter = useGet(zeroActivityStatusFilter$);
  const setFilter = useSet(setZeroActivityFilter$);
  const orgAgents = useGet(zeroActivityOrgAgents$);

  const logs = dataLoadable.state === "hasData" ? dataLoadable.data.data : [];
  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const totalPages =
    dataLoadable.state === "hasData"
      ? dataLoadable.data.pagination.totalPages
      : undefined;
  const isLoading = dataLoadable.state === "loading";

  // Build name → displayName lookup from org agents
  const nameToDisplay = new Map(orgAgents.map((a) => [a.name, a.displayName]));

  // Agent filter options: show display names, map back to compose name
  const agentOptions = [
    { value: "all", label: "All Agents" },
    ...orgAgents.map((a) => ({ value: a.name, label: a.displayName })),
  ];

  // Detail view when sub-route is present
  if (sub) {
    return <ZeroActivityDetailPage onBack={() => navigate("/zero/activity")} />;
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Fixed header: title + filters */}
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Activity
            </h1>
            <p className="text-sm text-muted-foreground">
              Logs and runs from your agents.
            </p>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Select
              value={agentFilter}
              onValueChange={(v) => setFilter("agent", v)}
            >
              <SelectTrigger className="h-9 w-[140px] gap-2 rounded-lg bg-muted/40 border-border/70">
                <IconFilter
                  size={14}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
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
              <SelectTrigger className="h-9 w-[140px] gap-2 rounded-lg bg-muted/40 border-border/70">
                <IconFilter
                  size={14}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      {/* Scrollable table area */}
      <div className="flex-1 min-h-0 overflow-auto px-4 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          {(logs.length > 0 || isLoading) && (
            <div
              className={cn(
                ROW_GRID,
                "sticky top-0 z-10 py-2 pb-1.5 border-b text-sm font-medium text-muted-foreground backdrop-blur-md bg-background/60",
              )}
            >
              <div className="text-left">Agent</div>
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
            <div className="flex items-center justify-center min-h-[20rem]">
              <p className="text-sm text-muted-foreground">
                {agentFilter === "all" && statusFilter === "all"
                  ? "No activity found."
                  : "No activity matches your filters."}
              </p>
            </div>
          ) : (
            logs.map((entry) => (
              <ActivityRow
                key={entry.id}
                entry={entry}
                onSelect={(id) => navigate(`/zero/activity/${id}`)}
                agentName={
                  nameToDisplay.get(entry.agentName) ?? entry.agentName
                }
              />
            ))
          )}
        </div>
      </div>

      {/* Fixed pagination footer */}
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
            onForwardTwoPages={() => detach(goForwardTwo(), Reason.DomCallback)}
            onBackTwoPages={() => goBackTwo()}
            onRowsPerPageChange={(limit) => setRowsPerPage(limit)}
          />
        </div>
      </div>
    </div>
  );
}
