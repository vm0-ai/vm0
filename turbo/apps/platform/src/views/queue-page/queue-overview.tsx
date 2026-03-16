import type { QueueData } from "../../signals/queue-page/queue-signals.ts";

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

interface StatCardProps {
  label: string;
  value: string;
  detail?: string;
}

function StatCard({ label, value, detail }: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

interface QueueOverviewProps {
  data: QueueData;
}

export function QueueOverview({ data }: QueueOverviewProps) {
  const { concurrency, queue, estimatedTimePerRun } = data;

  const etaTotal =
    estimatedTimePerRun && queue.length > 0
      ? formatDuration(estimatedTimePerRun * queue.length)
      : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <StatCard
        label="Concurrency"
        value={`${concurrency.active} / ${concurrency.limit}`}
        detail={`${concurrency.available} slot${concurrency.available !== 1 ? "s" : ""} available (${concurrency.tier})`}
      />
      <StatCard
        label="Queue Length"
        value={`${queue.length}`}
        detail={
          queue.length > 0
            ? `${queue.length} task${queue.length !== 1 ? "s" : ""} waiting`
            : "No tasks in queue"
        }
      />
      <StatCard
        label="Est. Clear Time"
        value={etaTotal ?? "--"}
        detail={
          estimatedTimePerRun
            ? `~${formatDuration(estimatedTimePerRun)} per run`
            : "No historical data"
        }
      />
    </div>
  );
}
