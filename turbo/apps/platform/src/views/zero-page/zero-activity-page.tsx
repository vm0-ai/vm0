// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLoadable } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
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
} from "@vm0/ui";
import { TRIGGER_SOURCE_LABELS } from "../../signals/zero-page/log-types.ts";
import { LogTable, STATUS_LABELS } from "./components/log-views/log-table.tsx";
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
  zeroActivityAvailableStatuses$,
  zeroActivityAvailableSources$,
  zeroActivityAvailableAgents$,
} from "../../signals/activity-page/activity-signals.ts";
import { Reason, detach } from "../../signals/utils.ts";

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
  const pageSignal = useGet(pageSignal$);

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
  const hasError = dataLoadable.state === "hasError";

  // Agent filter options: only agents with activity records
  const agentOptions = [
    { value: "all", label: "All agents" },
    ...(availableAgentsLoadable.state === "hasData"
      ? availableAgentsLoadable.data.map((a) => {
          return {
            value: a.name,
            label: a.displayName,
          };
        })
      : []),
  ];

  const statusOptions = [
    { value: "all", label: "All status" },
    ...(availableStatusesLoadable.state === "hasData"
      ? availableStatusesLoadable.data.map((s) => {
          return {
            value: s,
            label: STATUS_LABELS[s],
          };
        })
      : []),
  ];

  const sourceOptions = [
    { value: "all", label: "All sources" },
    ...(availableSourcesLoadable.state === "hasData"
      ? availableSourcesLoadable.data.map((s) => {
          return {
            value: s,
            label: TRIGGER_SOURCE_LABELS[s],
          };
        })
      : []),
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Fixed header: title + filters */}
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            <div className="hidden md:block">
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
                onValueChange={(v) => {
                  return setFilter("agent", v);
                }}
              >
                <SelectTrigger
                  aria-label="Agent filter"
                  className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium"
                >
                  <IconUsers size={14} stroke={1.5} className="shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.map((opt) => {
                    return (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  return setFilter("status", v);
                }}
              >
                <SelectTrigger
                  aria-label="Status filter"
                  className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium"
                >
                  <IconCircleDot size={14} stroke={1.5} className="shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((opt) => {
                    return (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Select
                value={sourceFilter}
                onValueChange={(v) => {
                  return setFilter("source", v);
                }}
              >
                <SelectTrigger
                  aria-label="Source filter"
                  className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium"
                >
                  <IconPlugConnected
                    size={14}
                    stroke={1.5}
                    className="shrink-0"
                  />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((opt) => {
                    return (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      {/* Scrollable table + pagination area */}
      <div className="flex-1 min-h-0 overflow-auto px-4 sm:px-6 pt-3">
        <div className="mx-auto max-w-[900px]">
          {hasError ? (
            <div
              role="alert"
              className="zero-card flex flex-col items-center justify-center gap-2 py-16 text-center"
            >
              <p className="text-sm font-medium text-destructive">
                Failed to load activity data
              </p>
              <p className="text-sm text-muted-foreground">
                Something went wrong. Please try again later.
              </p>
            </div>
          ) : (
            <>
              <div className="zero-card overflow-hidden pb-3">
                <LogTable
                  logs={logs}
                  isLoading={isLoading}
                  rowsPerPage={rowsPerPage}
                  showSource
                  hasActiveFilter={
                    agentFilter !== "all" ||
                    statusFilter !== "all" ||
                    sourceFilter !== "all"
                  }
                />
              </div>
              {(totalPages === undefined || totalPages > 1) && (
                <div className="py-4">
                  <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    rowsPerPage={rowsPerPage}
                    hasNext={hasNext}
                    hasPrev={hasPrev}
                    isLoading={isLoading}
                    labelClassName="font-normal text-muted-foreground"
                    buttonClassName="bg-transparent border-border/70"
                    onNextPage={() => {
                      return detach(goToNext(pageSignal), Reason.DomCallback);
                    }}
                    onPrevPage={() => {
                      return goToPrev();
                    }}
                    onForwardTwoPages={() => {
                      return detach(
                        goForwardTwo(pageSignal),
                        Reason.DomCallback,
                      );
                    }}
                    onBackTwoPages={() => {
                      return goBackTwo();
                    }}
                    onRowsPerPageChange={(limit) => {
                      return setRowsPerPage(limit);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
