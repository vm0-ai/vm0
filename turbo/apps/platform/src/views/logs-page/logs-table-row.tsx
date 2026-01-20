import { useSet } from "ccstate-react";
import { navigateToRunDetail$ } from "../../signals/logs-page/logs-signals.ts";
import type { Run } from "../../signals/logs-page/types.ts";
import { TableRow, TableCell } from "@vm0/ui";

interface LogsTableRowProps {
  run: Run;
}

export function LogsTableRow({ run }: LogsTableRowProps) {
  const navigate = useSet(navigateToRunDetail$);

  const handleClick = () => {
    navigate();
  };

  return (
    <TableRow onClick={handleClick} className="cursor-pointer hover:bg-gray-50">
      <TableCell>{run.id}</TableCell>
      <TableCell>{run.agent_name}</TableCell>
      <TableCell>{new Date(run.created_at).toLocaleString()}</TableCell>
    </TableRow>
  );
}
