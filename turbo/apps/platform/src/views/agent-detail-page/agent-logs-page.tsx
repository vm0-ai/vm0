import { useGet, useLoadable, useSet } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import type { MouseEvent } from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { AppShell } from "../layout/app-shell.tsx";
import { Pagination } from "../components/pagination.tsx";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import {
  agentDetail$,
  agentDetailLoading$,
  agentName$,
  isOwner$,
} from "../../signals/agent-detail/agent-detail.ts";
import {
  currentAgentLogs$,
  agentLogsHasPrev$,
  agentLogsCurrentPage$,
  agentLogsLimit$,
  goToNextAgentLogsPage$,
  goToPrevAgentLogsPage$,
  goForwardTwoAgentLogsPages$,
  goBackTwoAgentLogsPages$,
  setAgentLogsRowsPerPage$,
} from "../../signals/agent-detail/agent-logs.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentHeader } from "./agent-header.tsx";
import type { LogEntry } from "../../signals/logs-page/types.ts";

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "shortOffset",
  };
  return date.toLocaleString("en-US", options);
}

function AgentLogsTableHeader() {
  return (
    <TableHeader className="bg-muted">
      <TableRow className="hover:bg-transparent">
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[25%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Run ID</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[25%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Session ID</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[15%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Model</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[13%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Status</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[17%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">
            Generate time
          </span>
        </TableHead>
        <TableHead className="h-10 w-[44px] px-2" />
      </TableRow>
    </TableHeader>
  );
}

function AgentLogsTableSkeleton() {
  return (
    <Table>
      <AgentLogsTableHeader />
      <TableBody>
        {Array.from({ length: 8 }, (_, i) => (
          <TableRow key={`skeleton-${i}`} className="h-[53px]">
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-28" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-20" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-6 w-20 rounded-full" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell className="px-2 py-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface AgentLogsTableRowProps {
  entry: LogEntry;
}

function AgentLogsTableRow({ entry }: AgentLogsTableRowProps) {
  const navigate = useSet(navigateInReact$);
  const logDetailUrl = `/logs/${entry.id}`;

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.metaKey || event.ctrlKey) {
      window.open(logDetailUrl, "_blank");
      return;
    }
    navigate("/logs/:id", { pathParams: { id: entry.id } });
  };

  return (
    <TableRow
      className="h-[53px] cursor-pointer hover:bg-muted/50"
      onClick={handleRowClick}
    >
      <TableCell className="px-3 py-2 text-sm font-medium w-[25%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">{entry.id}</span>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[25%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.sessionId ?? "-"}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[15%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.framework ?? "-"}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2 w-[13%] min-w-[120px]">
        <div className="truncate whitespace-nowrap">
          <StatusBadge status={entry.status} />
        </div>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[17%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {formatTime(entry.createdAt)}
        </span>
      </TableCell>
      <TableCell className="w-[44px] px-2 py-2">
        <div className="flex size-full items-center justify-end pr-[12px]">
          <IconChevronRight className="size-4 flex-shrink-0" />
        </div>
      </TableCell>
    </TableRow>
  );
}

function AgentLogsTable() {
  const logsLoadable = useLoadable(currentAgentLogs$);

  if (logsLoadable.state === "loading") {
    return <AgentLogsTableSkeleton />;
  }

  if (logsLoadable.state === "hasError") {
    const errorMessage =
      logsLoadable.error instanceof Error
        ? logsLoadable.error.message
        : "Failed to load logs";
    return (
      <Table>
        <AgentLogsTableHeader />
        <TableBody>
          <TableRow>
            <td colSpan={6} className="p-4 text-center text-destructive">
              Error: {errorMessage}
            </td>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  if (logsLoadable.data.data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <p className="text-lg">Nothing here yet</p>
        <p className="mt-2 text-sm">
          Your agent runs will show up here once they start working their magic.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <AgentLogsTableHeader />
      <TableBody>
        {logsLoadable.data.data.map((entry) => (
          <AgentLogsTableRow key={entry.id} entry={entry} />
        ))}
      </TableBody>
    </Table>
  );
}

function AgentLogsPagination() {
  const logsLoadable = useLoadable(currentAgentLogs$);
  const hasPrev = useGet(agentLogsHasPrev$);
  const currentPage = useGet(agentLogsCurrentPage$);
  const rowsPerPage = useGet(agentLogsLimit$);
  const goToNext = useSet(goToNextAgentLogsPage$);
  const goToPrev = useSet(goToPrevAgentLogsPage$);
  const goForwardTwo = useSet(goForwardTwoAgentLogsPages$);
  const goBackTwo = useSet(goBackTwoAgentLogsPages$);
  const setRowsPerPageFn = useSet(setAgentLogsRowsPerPage$);

  const hasNext =
    logsLoadable.state === "hasData" && logsLoadable.data.pagination.hasMore;
  const isLoading = logsLoadable.state === "loading";
  const totalPages =
    logsLoadable.state === "hasData"
      ? logsLoadable.data.pagination.totalPages
      : undefined;

  return (
    <Pagination
      currentPage={currentPage}
      totalPages={totalPages}
      rowsPerPage={rowsPerPage}
      hasNext={hasNext}
      hasPrev={hasPrev}
      isLoading={isLoading}
      onNextPage={() => detach(goToNext(), Reason.DomCallback)}
      onPrevPage={() => goToPrev()}
      onForwardTwoPages={() => detach(goForwardTwo(), Reason.DomCallback)}
      onBackTwoPages={() => goBackTwo()}
      onRowsPerPageChange={(limit) => setRowsPerPageFn(limit)}
    />
  );
}

export function AgentLogsPage() {
  const agentName = useGet(agentName$);
  const detail = useGet(agentDetail$);
  const loading = useGet(agentDetailLoading$);
  const isOwner = useGet(isOwner$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        agentName ?? "Loading...",
        "Logs",
      ]}
    >
      <div className="flex flex-col gap-[22px] p-8 min-h-full">
        {loading ? (
          <AgentLogsPageSkeleton />
        ) : detail ? (
          <>
            <AgentHeader detail={detail} isOwner={isOwner} />
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <AgentLogsTable />
            </div>
            <AgentLogsPagination />
          </>
        ) : (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">Agent not found</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function AgentLogsPageSkeleton() {
  return (
    <>
      <div className="flex items-center gap-3.5">
        <Skeleton className="h-14 w-14 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <AgentLogsTableSkeleton />
      </div>
    </>
  );
}
