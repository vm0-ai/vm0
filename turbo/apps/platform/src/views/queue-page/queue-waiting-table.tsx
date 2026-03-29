import { useGet, useSet } from "ccstate-react";
import {
  cancelQueueRun$,
  type QueueEntry,
} from "../../signals/queue-page/queue-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Link } from "../router/link.tsx";

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

function WaitingRow({
  entry,
  estimatedTimePerRun,
}: {
  entry: QueueEntry;
  estimatedTimePerRun: number | null;
}) {
  const cancelRun = useSet(cancelQueueRun$);
  const pageSignal = useGet(pageSignal$);
  const runId = entry.runId;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40 last:border-b-0">
      <span className="w-6 text-center text-xs font-medium text-muted-foreground tabular-nums shrink-0">
        {entry.position}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {entry.agentDisplayName ?? entry.agentName}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate">
            {entry.userEmail}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatRelativeTime(entry.createdAt)}
          </span>
          {estimatedTimePerRun && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatDuration(estimatedTimePerRun * entry.position)} wait
              </span>
            </>
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
        {entry.isOwner && runId && (
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

interface QueueWaitingTableProps {
  queue: QueueEntry[];
  estimatedTimePerRun: number | null;
}

export function QueueWaitingTable({
  queue,
  estimatedTimePerRun,
}: QueueWaitingTableProps) {
  return (
    <section>
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        Waiting ({queue.length})
      </h3>
      {queue.length === 0 ? (
        <div className="rounded-xl bg-card zero-border p-5 text-center text-sm text-muted-foreground">
          No tasks in queue.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card zero-border">
          {queue.map((entry) => (
            <WaitingRow
              key={entry.runId ?? `queue-${entry.position}`}
              entry={entry}
              estimatedTimePerRun={estimatedTimePerRun}
            />
          ))}
        </div>
      )}
    </section>
  );
}
