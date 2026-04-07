import { useGet, useSet } from "ccstate-react";
import { IconLoader2, IconClock } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import {
  cancelQueueRun$,
  type RunningTask,
} from "../../signals/queue-page/queue-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Link } from "../router/link.tsx";
import { detach, Reason } from "../../signals/utils.ts";

const ROW_GRID = "grid grid-cols-[1fr_1fr_6rem_5rem_4rem] gap-x-6 items-center";

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
  const cancelRun = useSet(cancelQueueRun$);
  const pageSignal = useGet(pageSignal$);
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground mb-2 px-1">
        Running ({tasks.length})
      </p>
      {tasks.length === 0 ? (
        <div className="zero-card p-6 text-center text-sm text-muted-foreground">
          No tasks currently running.
        </div>
      ) : (
        <div className="zero-card overflow-hidden px-4 sm:px-7 pb-3">
          <div
            className={cn(
              ROW_GRID,
              "sticky top-0 z-10 -mx-4 px-4 py-3 text-sm font-medium text-muted-foreground bg-card border-b border-border/40",
            )}
          >
            <div>Agent</div>
            <div>User</div>
            <div>Started</div>
            <div>Activity logs</div>
            <div>Cancel</div>
          </div>
          {tasks.map((task) => {
            const runId = task.runId;
            return (
              <div
                key={runId ?? task.agentName}
                className={cn(
                  ROW_GRID,
                  "py-3 -mx-4 px-4 border-b border-border/40 last:border-b-0",
                )}
              >
                <div className="text-sm font-medium text-foreground truncate">
                  {task.agentDisplayName ?? task.agentName}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {task.userEmail}
                </div>
                <div className="text-sm text-muted-foreground">
                  {task.startedAt ? (
                    <span className="inline-flex items-center gap-1">
                      <IconClock size={12} stroke={1.5} />
                      {formatRelativeTime(task.startedAt)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <IconLoader2
                        size={12}
                        stroke={1.5}
                        className="animate-spin"
                      />
                      Starting
                    </span>
                  )}
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
                  {task.isOwner && runId && (
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
