import { useSet } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import type { MouseEvent } from "react";
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
  const logDetailUrl = `/logs/${entry.id}`;

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    // Open in new tab if Cmd (Mac) or Ctrl (Windows/Linux) is pressed
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
      <TableCell className="px-3 py-2 text-sm font-medium w-[20%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">{entry.id}</span>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[20%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.sessionId ?? "-"}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[15%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.agentName}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[12%] min-w-[120px]">
        <span className="block truncate whitespace-nowrap">
          {entry.framework ?? "-"}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2 w-[13%] min-w-[120px]">
        <div className="truncate whitespace-nowrap">
          <StatusBadge status={entry.status} />
        </div>
      </TableCell>
      <TableCell className="px-3 py-2 text-sm w-[15%] min-w-[120px]">
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
