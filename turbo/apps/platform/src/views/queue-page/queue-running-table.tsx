import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@vm0/ui";
import type { RunningTask } from "../../signals/queue-page/queue-signals.ts";
import { Link } from "../router/link.tsx";

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  return `${(diff / 3_600_000).toFixed(1)}h ago`;
}

interface QueueRunningTableProps {
  tasks: RunningTask[];
}

export function QueueRunningTable({ tasks }: QueueRunningTableProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-foreground mb-2">
        Running ({tasks.length})
      </h3>
      {tasks.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No tasks currently running.
        </div>
      ) : (
        <Table>
          <TableHeader className="bg-muted">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                Agent
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                User
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                Started
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[100px]">
                Action
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task, i) => (
              <TableRow key={task.runId ?? `running-${i}`}>
                <TableCell className="px-3 py-2 text-sm">
                  {task.agentName}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm text-muted-foreground">
                  {task.userEmail}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm text-muted-foreground">
                  {task.startedAt ? formatRelativeTime(task.startedAt) : "--"}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm">
                  {task.isOwner && task.runId ? (
                    <Link
                      pathname="/logs/:id"
                      options={{ pathParams: { id: task.runId } }}
                      className="text-primary hover:underline"
                    >
                      View
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
