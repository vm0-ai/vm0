import { useLoadable } from "ccstate-react";
import type { Computed } from "ccstate";
import { currentPageLogs$ } from "../../signals/logs-page/logs-signals.ts";
import { LogsTableRow } from "./logs-table-row.tsx";
import { LogsEmptyState } from "./logs-empty-state.tsx";
import { Table, TableHeader, TableBody, TableHead, TableRow } from "@vm0/ui";
import type { LogsListResponse } from "../../signals/logs-page/types.ts";

function LogsTableHeader() {
  return (
    <TableHeader className="bg-muted">
      <TableRow className="hover:bg-transparent">
        <TableHead className="h-10 w-[180px] px-3 text-sm font-medium text-foreground">
          Run ID
        </TableHead>
        <TableHead className="h-10 w-[180px] px-3 text-sm font-medium text-foreground">
          Session ID
        </TableHead>
        <TableHead className="h-10 w-[120px] px-3 text-sm font-medium text-foreground">
          Agent
        </TableHead>
        <TableHead className="h-10 w-[180px] px-3 text-sm font-medium text-foreground">
          Framework
        </TableHead>
        <TableHead className="h-10 w-[100px] px-3 text-sm font-medium text-foreground">
          Status
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
          Generate time
        </TableHead>
        <TableHead className="h-10 w-[50px] px-2" />
      </TableRow>
    </TableHeader>
  );
}

function LoadingTable() {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <Table>
        <LogsTableHeader />
        <TableBody>
          <TableRow>
            <td colSpan={7} className="p-4 text-center">
              Loading...
            </td>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
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
      <div className="overflow-hidden rounded-md border border-border bg-card">
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
      </div>
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
      <div className="overflow-hidden rounded-md border border-border bg-card">
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
      </div>
    );
  }

  if (dataLoadable.data.data.length === 0) {
    return <LogsEmptyState />;
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <Table>
        <LogsTableHeader />
        <TableBody>
          {dataLoadable.data.data.map((entry) => (
            <LogsTableRow key={entry.id} logId={entry.id} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
