import { useLoadable } from "ccstate-react";
import { currentPageLogs$ } from "../../signals/logs-page/logs-signals.ts";
import { LogsTableRow } from "./logs-table-row.tsx";
import { LogsEmptyState } from "./logs-empty-state.tsx";
import { LogsTableSkeleton } from "./logs-table-skeleton.tsx";
import { Table, TableHeader, TableBody, TableHead, TableRow } from "@vm0/ui";

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

export function LogsTable() {
  const logsLoadable = useLoadable(currentPageLogs$);

  if (logsLoadable.state === "loading") {
    return <LogsTableSkeleton />;
  }

  if (logsLoadable.state === "hasError") {
    const errorMessage =
      logsLoadable.error instanceof Error
        ? logsLoadable.error.message
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

  if (logsLoadable.data.data.length === 0) {
    return <LogsEmptyState />;
  }

  return (
    <Table>
      <LogsTableHeader />
      <TableBody>
        {logsLoadable.data.data.map((entry) => (
          <LogsTableRow key={entry.id} entry={entry} />
        ))}
      </TableBody>
    </Table>
  );
}
