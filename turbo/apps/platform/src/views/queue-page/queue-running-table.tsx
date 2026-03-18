import { IconLoader2, IconClock } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import type { RunningTask } from "../../signals/queue-page/queue-signals.ts";
import { SimpleLink } from "../router/link.tsx";

const ROW_GRID = "grid grid-cols-[1fr_1fr_6rem_5rem] gap-x-4 items-center";

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
      <p className="text-sm font-medium text-muted-foreground mb-2 px-1">
        Running ({tasks.length})
      </p>
      {tasks.length === 0 ? (
        <div className="zero-card p-6 text-center text-sm text-muted-foreground">
          No tasks currently running.
        </div>
      ) : (
        <div className="zero-card overflow-hidden px-6 pb-2">
          <div
            className={cn(
              ROW_GRID,
              "sticky top-0 z-10 -mx-4 px-4 py-2.5 text-xs font-medium text-muted-foreground bg-card border-b border-border/40",
            )}
          >
            <div>Agent</div>
            <div>User</div>
            <div>Started</div>
            <div>Activity logs</div>
          </div>
          {tasks.map((task, i) => (
            <div
              key={task.runId ?? `running-${i}`}
              className={cn(
                ROW_GRID,
                "py-2.5 -mx-4 px-4 border-b border-border/40 last:border-b-0",
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
                {task.runId ? (
                  <SimpleLink
                    href={`/activity/${task.runId}`}
                    className="text-sm text-primary hover:underline"
                  >
                    View logs
                  </SimpleLink>
                ) : (
                  <span className="text-sm text-muted-foreground">--</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
