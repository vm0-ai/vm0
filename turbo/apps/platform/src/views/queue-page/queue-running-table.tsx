import { useGet, useSet } from "ccstate-react";
import { IconLoader2, IconClock } from "@tabler/icons-react";
import {
  cancelQueueRun$,
  type RunningTask,
} from "../../signals/queue-page/queue-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
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

function RunningRow({ task }: { task: RunningTask }) {
  const cancelRun = useSet(cancelQueueRun$);
  const pageSignal = useGet(pageSignal$);
  const runId = task.runId;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 last:border-b-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {task.agentDisplayName ?? task.agentName}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate">
            {task.userEmail}
          </span>
          <span className="text-muted-foreground/40">·</span>
          {task.startedAt ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <IconClock size={11} stroke={1.5} />
              {formatRelativeTime(task.startedAt)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <IconLoader2 size={11} stroke={1.5} className="animate-spin" />
              Starting
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {runId && (
          <Link
            pathname="/activity/:runId"
            options={{ pathParams: { runId: runId } }}
            className="text-xs text-primary hover:underline"
          >
            Logs
          </Link>
        )}
        {task.isOwner && runId && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <button
              type="button"
              className="text-xs text-destructive hover:underline"
              onClick={() => void cancelRun(runId, pageSignal)}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

interface QueueRunningTableProps {
  tasks: RunningTask[];
}

export function QueueRunningTable({ tasks }: QueueRunningTableProps) {
  return (
    <section>
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        Running ({tasks.length})
      </h3>
      {tasks.length === 0 ? (
        <div className="rounded-xl bg-card zero-border p-5 text-center text-sm text-muted-foreground">
          No tasks currently running.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card zero-border">
          {tasks.map((task, i) => (
            <RunningRow key={task.runId ?? `running-${i}`} task={task} />
          ))}
        </div>
      )}
    </section>
  );
}
