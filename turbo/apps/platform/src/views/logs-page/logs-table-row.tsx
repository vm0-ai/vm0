import { useSet } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import { navigateInReact$ } from "../../signals/route.ts";
import { TableRow, TableCell } from "@vm0/ui";
import { StatusBadge } from "./status-badge.tsx";
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

interface LogsTableRowProps {
  entry: LogEntry;
}

export function LogsTableRow({ entry }: LogsTableRowProps) {
  const navigate = useSet(navigateInReact$);

  const handleRowClick = () => {
    navigate("/logs/:id", { pathParams: { id: entry.id } });
  };

  return (
    <TableRow
      className="h-[53px] cursor-pointer hover:bg-muted/50"
      onClick={handleRowClick}
    >
      <TableCell className="max-w-[180px] px-3 py-2 text-sm font-medium">
        <span className="block truncate">{entry.id}</span>
      </TableCell>
      <TableCell className="max-w-[180px] px-3 py-2 text-sm font-medium">
        <span className="block truncate">{entry.sessionId ?? "-"}</span>
      </TableCell>
      <TableCell className="w-[120px] truncate px-3 py-2 text-sm font-medium">
        {entry.agentName}
      </TableCell>
      <TableCell className="w-[180px] truncate px-3 py-2 text-sm font-medium">
        {entry.framework ?? "-"}
      </TableCell>
      <TableCell className="w-[100px] px-3 py-2">
        <StatusBadge status={entry.status} />
      </TableCell>
      <TableCell className="px-3 py-2 text-sm font-medium">
        {formatTime(entry.createdAt)}
      </TableCell>
      <TableCell className="w-[50px] px-2 py-2">
        <div className="flex size-8 items-center justify-center">
          <IconChevronRight className="size-6 text-muted-foreground" />
        </div>
      </TableCell>
    </TableRow>
  );
}
