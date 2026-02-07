import { useLoadable } from "ccstate-react";
import type { Computed } from "ccstate";
import { currentPageLogs$ } from "../../signals/logs-page/logs-signals.ts";
import { LogsTableRow } from "./logs-table-row.tsx";
import { LogsEmptyState } from "./logs-empty-state.tsx";
import { LogsTableSkeleton } from "./logs-table-skeleton.tsx";
import { Table, TableHeader, TableBody, TableHead, TableRow } from "@vm0/ui";
import type { LogsListResponse } from "../../signals/logs-page/types.ts";

function LogsTableHeader() {
  return (
    <TableHeader className="bg-muted">
      <TableRow className="hover:bg-transparent">
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[20%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Run ID</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[20%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Session ID</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[15%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Agent</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[12%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Framework</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[13%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Status</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[15%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">
            Generate time
          </span>
        </TableHead>
        <TableHead className="h-10 w-[44px] px-2" />
      </TableRow>
    </TableHeader>
  );
}

function LoadingTable() {
  return <LogsTableSkeleton />;
}

export function LogsTable() {
  const currentPage = useLoadable(currentPageLogs$);

  if (currentPage.state === "loading") {
    return <LoadingTable />;
  }

  if (currentPage.state === "hasError") {
    const errorMessage =
      currentPage.error instanceof Error
        ? currentPage.error.message
        : "Failed to load logs";
    return (
      <Table>
        <LogsTableHeader />
        <TableBody>
          <TableRow>
            <td colSpan={7} className="p-4 text-center text-destructive">
              Error: {errorMessage}
            </td>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  if (currentPage.data === null) {
    return <LoadingTable />;
  }

  return <LogsTableData pageComputed={currentPage.data} />;
}

interface LogsTableDataProps {
  pageComputed: Computed<Promise<LogsListResponse>>;
}

function LogsTableData({ pageComputed }: LogsTableDataProps) {
  const dataLoadable = useLoadable(pageComputed);

  if (dataLoadable.state === "loading") {
    return <LoadingTable />;
  }

  if (dataLoadable.state === "hasError") {
    const errorMessage =
      dataLoadable.error instanceof Error
        ? dataLoadable.error.message
        : "Failed to load logs";
    return (
      <Table>
        <LogsTableHeader />
        <TableBody>
          <TableRow>
            <td colSpan={7} className="p-4 text-center text-destructive">
              Error: {errorMessage}
            </td>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  if (dataLoadable.data.data.length === 0) {
    return <LogsEmptyState />;
  }

  return (
    <Table>
      <LogsTableHeader />
      <TableBody>
        {dataLoadable.data.data.map((entry) => (
          <LogsTableRow key={entry.id} entry={entry} />
        ))}
      </TableBody>
    </Table>
  );
}
