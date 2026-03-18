import { IconServer, IconStack2, IconHourglass } from "@tabler/icons-react";
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
  icon: React.ReactNode;
}

function StatCard({ label, value, detail, icon }: StatCardProps) {
  return (
    <div className="zero-card p-4">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-muted-foreground">{icon}</span>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </p>
      </div>
      <p className="text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      {detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      )}
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
        icon={<IconServer size={14} stroke={1.5} />}
        label="Concurrency"
        value={`${concurrency.active} / ${concurrency.limit}`}
        detail={`${concurrency.available} slot${concurrency.available !== 1 ? "s" : ""} available (${concurrency.tier})`}
      />
      <StatCard
        icon={<IconStack2 size={14} stroke={1.5} />}
        label="Queue Length"
        value={`${queue.length}`}
        detail={
          queue.length > 0
            ? `${queue.length} task${queue.length !== 1 ? "s" : ""} waiting`
            : "No tasks in queue"
        }
      />
      <StatCard
        icon={<IconHourglass size={14} stroke={1.5} />}
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
