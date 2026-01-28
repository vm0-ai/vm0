import { useSet, useLoadable } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import { getOrCreateLogDetail$ } from "../../signals/logs-page/logs-signals.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { TableRow, TableCell } from "@vm0/ui";
import { StatusBadge } from "./status-badge.tsx";

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

interface LogsTableRowProps {
  logId: string;
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
        <td colSpan={7} className="p-2 text-center text-muted-foreground">
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
        <td colSpan={7} className="p-2 text-center text-destructive">
          Error: {errorMessage}
        </td>
      </TableRow>
    );
  }

  const detail = loadable.data;

  return (
    <TableRow
      className="h-[53px] cursor-pointer hover:bg-muted/50"
      onClick={handleRowClick}
    >
      <TableCell className="max-w-[180px] px-3 py-2 text-sm font-medium">
        <span className="block truncate">{detail.id}</span>
      </TableCell>
      <TableCell className="max-w-[180px] px-3 py-2 text-sm font-medium">
        <span className="block truncate">{detail.sessionId ?? "-"}</span>
      </TableCell>
      <TableCell className="w-[120px] truncate px-3 py-2 text-sm font-medium">
        {detail.agentName}
      </TableCell>
      <TableCell className="w-[180px] truncate px-3 py-2 text-sm font-medium">
        {detail.framework}
      </TableCell>
      <TableCell className="w-[100px] px-3 py-2">
        <StatusBadge status={detail.status} />
      </TableCell>
      <TableCell className="px-3 py-2 text-sm font-medium">
        {formatTime(detail.createdAt)}
      </TableCell>
      <TableCell className="w-[50px] px-2 py-2">
        <div className="flex size-8 items-center justify-center">
          <IconChevronRight className="size-6 text-muted-foreground" />
        </div>
      </TableCell>
    </TableRow>
  );
}
