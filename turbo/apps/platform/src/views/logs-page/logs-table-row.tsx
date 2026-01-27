import { useSet, useLoadable } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import { getOrCreateLogDetail$ } from "../../signals/logs-page/logs-signals.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import type { LogStatus } from "../../signals/logs-page/types.ts";
import { TableRow, TableCell } from "@vm0/ui";

interface LogsTableRowProps {
  logId: string;
}

function StatusBadge({ status }: { status: LogStatus }) {
  const statusStyles: Record<LogStatus, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    timeout: "bg-orange-100 text-orange-800",
    cancelled: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusStyles[status]}`}
    >
      {status}
    </span>
  );
}

export function LogsTableRow({ logId }: LogsTableRowProps) {
  // Get or create the log detail computed (command is idempotent due to caching)
  const getOrCreateLogDetail = useSet(getOrCreateLogDetail$);
  const navigate = useSet(navigateInReact$);
  const detail$ = getOrCreateLogDetail(logId);
  const loadable = useLoadable(detail$);

  const handleRowClick = () => {
    navigate("/logs/:id", { pathParams: { id: logId } });
  };

  if (loadable.state === "loading") {
    return (
      <TableRow>
        <td colSpan={7} className="p-4 text-center text-muted-foreground">
          Loading...
        </td>
      </TableRow>
    );
  }

  if (loadable.state === "hasError") {
    const errorMessage =
      loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load details";
    return (
      <TableRow>
        <td colSpan={7} className="p-4 text-center text-destructive">
          Error: {errorMessage}
        </td>
      </TableRow>
    );
  }

  const detail = loadable.data;

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50"
      onClick={handleRowClick}
    >
      <TableCell className="font-mono text-sm">{detail.id}</TableCell>
      <TableCell className="font-mono text-sm">
        {detail.sessionId ?? "-"}
      </TableCell>
      <TableCell>{detail.agentName}</TableCell>
      <TableCell>{detail.provider}</TableCell>
      <TableCell>
        <StatusBadge status={detail.status} />
      </TableCell>
      <TableCell>{new Date(detail.createdAt).toLocaleString()}</TableCell>
      <TableCell className="w-8">
        <IconChevronRight className="h-4 w-4 text-muted-foreground" />
      </TableCell>
    </TableRow>
  );
}
