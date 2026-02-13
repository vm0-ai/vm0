import { useGet, useLoadable, useSet } from "ccstate-react";
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
import {
  agentDetail$,
  agentDetailLoading$,
  agentName$,
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
import { AgentAvatar } from "./agent-avatar.tsx";
import type { AgentDetail } from "../../signals/agent-detail/types.ts";
import type { LogEntry } from "../../signals/logs-page/types.ts";

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
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[25%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Model</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[25%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">
            Generate time
          </span>
        </TableHead>
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
              <Skeleton className="h-4 w-32" />
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
      <TableCell className="px-3 py-2 text-sm w-[25%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.framework ?? "-"}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[25%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.createdAt}
        </span>
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
            <td colSpan={4} className="p-4 text-center text-destructive">
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

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        {
          label: agentName ?? "Loading...",
          path: agentName ? "/agents/:name" : undefined,
          pathParams: agentName ? { name: agentName } : undefined,
        },
        "Logs",
      ]}
    >
      <div className="flex flex-col gap-[22px] p-8 min-h-full">
        {loading ? (
          <AgentLogsPageSkeleton />
        ) : detail ? (
          <>
            <AgentLogsHeader detail={detail} />
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

function AgentLogsHeader({ detail }: { detail: AgentDetail }) {
  const agentKeys = detail.content?.agents
    ? Object.keys(detail.content.agents)
    : [];
  const firstKey = agentKeys[0];
  const agentDef = firstKey ? detail.content?.agents[firstKey] : null;
  const description = agentDef?.description;

  return (
    <div className="flex items-center gap-3.5">
      <AgentAvatar name={detail.name} size="lg" />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <h1 className="text-2xl leading-8 font-normal text-foreground truncate">
          {detail.name}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground truncate">
            {description}
          </p>
        )}
      </div>
    </div>
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
