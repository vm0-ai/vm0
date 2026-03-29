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

interface StatRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}

function StatRow({ icon, label, value, detail }: StatRowProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {detail && (
          <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
        )}
      </div>
      <span className="text-sm font-semibold tabular-nums text-foreground shrink-0">
        {value}
      </span>
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
    <div className="overflow-hidden rounded-xl bg-card zero-border">
      <StatRow
        icon={<IconServer size={16} stroke={1.5} />}
        label="Concurrency"
        value={`${concurrency.active} / ${concurrency.limit}`}
        detail={`${concurrency.available} slot${concurrency.available !== 1 ? "s" : ""} available`}
      />
      <div className="h-0 zero-border-t mx-4" />
      <StatRow
        icon={<IconStack2 size={16} stroke={1.5} />}
        label="Queue length"
        value={`${queue.length}`}
        detail={
          queue.length > 0
            ? `${queue.length} task${queue.length !== 1 ? "s" : ""} waiting`
            : "No tasks in queue"
        }
      />
      <div className="h-0 zero-border-t mx-4" />
      <StatRow
        icon={<IconHourglass size={16} stroke={1.5} />}
        label="Est. clear time"
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
