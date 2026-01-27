import { useSet, useLoadable } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import { getOrCreateLogDetail$ } from "../../signals/logs-page/logs-signals.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { TableRow, TableCell } from "@vm0/ui";
import { StatusBadge } from "./status-badge.tsx";

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
        <StatusBadge status={detail.status} variant="compact" />
      </TableCell>
      <TableCell>{new Date(detail.createdAt).toLocaleString()}</TableCell>
      <TableCell className="w-8">
        <IconChevronRight className="h-4 w-4 text-muted-foreground" />
      </TableCell>
    </TableRow>
  );
}
