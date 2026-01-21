import type { Run } from "../../signals/logs-page/types.ts";
import { TableRow, TableCell } from "@vm0/ui";

interface LogsTableRowProps {
  run: Run;
}

export function LogsTableRow({ run }: LogsTableRowProps) {
  // TODO: Add navigation to run detail page once it's implemented
  return (
    <TableRow>
      <TableCell>{run.id}</TableCell>
      <TableCell>{run.agent_name}</TableCell>
      <TableCell>{new Date(run.created_at).toLocaleString()}</TableCell>
    </TableRow>
  );
}
