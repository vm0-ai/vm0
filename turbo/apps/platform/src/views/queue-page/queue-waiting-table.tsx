import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  cancelQueueRun$,
  type QueueEntry,
} from "../../signals/queue-page/queue-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Link } from "../router/link.tsx";
import { detach, Reason } from "../../signals/utils.ts";

const ROW_GRID =
  "grid grid-cols-[2.5rem_1fr_1fr_5rem_5rem_7rem_4rem] gap-x-6 items-center";

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

interface QueueWaitingTableProps {
  queue: QueueEntry[];
  estimatedTimePerRun: number | null;
}

export function QueueWaitingTable({
  queue,
  estimatedTimePerRun,
}: QueueWaitingTableProps) {
  const cancelRun = useSet(cancelQueueRun$);
  const pageSignal = useGet(pageSignal$);
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground mb-2 px-1">
        Waiting ({queue.length})
      </p>
      {queue.length === 0 ? (
        <div className="zero-card p-6 text-center text-sm text-muted-foreground">
          No tasks in queue.
        </div>
      ) : (
        <div className="zero-card overflow-hidden px-4 sm:px-7 pb-3">
          <div
            className={cn(
              ROW_GRID,
              "sticky top-0 z-10 -mx-4 px-4 py-3 text-sm font-medium text-muted-foreground bg-card border-b border-border/40",
            )}
          >
            <div>#</div>
            <div>Agent</div>
            <div>User</div>
            <div>Queued</div>
            <div>Est. Wait</div>
            <div>Activity logs</div>
            <div>Cancel</div>
          </div>
          {queue.map((entry) => {
            const runId = entry.runId;
            return (
              <div
                key={runId ?? `queue-${entry.position}`}
                className={cn(
                  ROW_GRID,
                  "py-3 -mx-4 px-4 border-b border-border/40 last:border-b-0",
                )}
              >
                <div className="text-sm font-medium text-muted-foreground tabular-nums">
                  {entry.position}
                </div>
                <div className="text-sm font-medium text-foreground truncate">
                  {entry.agentDisplayName ?? entry.agentName}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {entry.userEmail}
                </div>
                <div className="text-sm text-muted-foreground tabular-nums">
                  {formatRelativeTime(entry.createdAt)}
                </div>
                <div className="text-sm text-muted-foreground tabular-nums">
                  {estimatedTimePerRun
                    ? formatDuration(estimatedTimePerRun * entry.position)
                    : "--"}
                </div>
                <div>
                  {runId ? (
                    <Link
                      pathname="/activities/:id"
                      options={{ pathParams: { id: runId } }}
                      className="text-sm text-primary hover:underline"
                    >
                      View logs
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">--</span>
                  )}
                </div>
                <div>
                  {entry.isOwner && runId && (
                    <button
                      type="button"
                      className="text-sm text-destructive hover:underline"
                      onClick={() => {
                        detach(
                          cancelRun(runId, pageSignal),
                          Reason.DomCallback,
                        );
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
