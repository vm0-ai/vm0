import { useGet, useLoadable } from "ccstate-react";
import type { Computed } from "ccstate";
import { logs$ } from "../../signals/logs-page/logs-signals.ts";
import { LogsTableRow } from "./logs-table-row.tsx";
import { LogsEmptyState } from "./logs-empty-state.tsx";
import type { LogsListResponse } from "../../signals/logs-page/types.ts";
import { Table, TableHeader, TableBody, TableHead, TableRow } from "@vm0/ui";

interface LogBatchProps {
  logComputed: Computed<Promise<LogsListResponse>>;
  index: number;
}

function LogBatch({ logComputed, index }: LogBatchProps) {
  const loadable = useLoadable(logComputed);

  if (loadable.state === "loading") {
    return (
      <TableRow key={`loading-${index}`}>
        <td colSpan={7} className="p-4 text-center">
          Loading...
        </td>
      </TableRow>
    );
  }

  if (loadable.state === "hasError") {
    const errorMessage =
      loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load logs";
    return (
      <TableRow key={`error-${index}`}>
        <td colSpan={7} className="p-4 text-center text-destructive">
          Error: {errorMessage}
        </td>
      </TableRow>
    );
  }

  return (
    <>
      {loadable.data.data.map((entry) => (
        <LogsTableRow key={entry.id} logId={entry.id} />
      ))}
    </>
  );
}

export function LogsTable() {
  const logs = useGet(logs$);

  if (logs.length === 0) {
    return <LogsEmptyState />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run ID</TableHead>
          <TableHead>Session ID</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Generate time</TableHead>
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((logComputed, index) => (
          <LogBatch
            key={`batch-${index}`}
            logComputed={logComputed}
            index={index}
          />
        ))}
      </TableBody>
    </Table>
  );
}
