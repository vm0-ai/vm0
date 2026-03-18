import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@vm0/ui";
import type { QueueEntry } from "../../signals/queue-page/queue-signals.ts";
import { SimpleLink } from "../router/link.tsx";

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `~${Math.round(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `~${Math.round(ms / 60_000)}m`;
  }
  return `~${(ms / 3_600_000).toFixed(1)}h`;
}

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

function triggerSourceLabel(source: "schedule" | "chat" | "api"): string {
  switch (source) {
    case "schedule": {
      return "Schedule";
    }
    case "chat": {
      return "Chat";
    }
    case "api": {
      return "API";
    }
  }
}

interface QueueWaitingTableProps {
  queue: QueueEntry[];
  estimatedTimePerRun: number | null;
}

export function QueueWaitingTable({
  queue,
  estimatedTimePerRun,
}: QueueWaitingTableProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-foreground mb-2">
        Waiting ({queue.length})
      </h3>
      {queue.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No tasks in queue.
        </div>
      ) : (
        <Table>
          <TableHeader className="bg-muted">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[50px]">
                #
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                Agent
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                User
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                Queued
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                Est. Wait
              </TableHead>
              <TableHead className="h-10 px-3 text-sm font-medium text-foreground">
                Details
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.map((entry) => (
              <TableRow key={entry.runId ?? `queue-${entry.position}`}>
                <TableCell className="px-3 py-2 text-sm text-muted-foreground">
                  {entry.position}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm">
                  {entry.agentName}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm text-muted-foreground">
                  {entry.userEmail}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm text-muted-foreground">
                  {formatRelativeTime(entry.createdAt)}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm text-muted-foreground">
                  {estimatedTimePerRun
                    ? formatDuration(estimatedTimePerRun * entry.position)
                    : "--"}
                </TableCell>
                <TableCell className="px-3 py-2 text-sm">
                  {(entry.prompt ?? entry.sessionLink ?? entry.runId) ? (
                    <OwnerDetails entry={entry} />
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

function OwnerDetails({ entry }: { entry: QueueEntry }) {
  return (
    <div className="flex flex-col gap-1">
      {entry.triggerSource && (
        <span className="text-xs text-muted-foreground">
          {triggerSourceLabel(entry.triggerSource)}
        </span>
      )}
      {entry.prompt && (
        <span className="text-xs text-muted-foreground truncate max-w-[200px] block">
          {entry.prompt}
        </span>
      )}
      <div className="flex gap-2">
        {entry.runId && (
          <SimpleLink
            href={`/activity/${entry.runId}`}
            className="text-xs text-primary hover:underline"
          >
            Run log
          </SimpleLink>
        )}
        {entry.sessionLink && (
          <SimpleLink
            href={entry.sessionLink}
            className="text-xs text-primary hover:underline"
          >
            Session
          </SimpleLink>
        )}
      </div>
    </div>
  );
}
