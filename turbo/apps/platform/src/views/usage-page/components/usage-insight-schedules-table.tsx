import type { UsageInsightResponse } from "@vm0/core";
import type { InsightMetric } from "../../../signals/usage-page/usage-insight-signals.ts";

function formatValue(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function UsageInsightSchedulesTable({
  data,
  metric,
}: {
  data: UsageInsightResponse;
  metric: InsightMetric;
}) {
  const { schedules, scheduleOtherCount, scheduleOtherCredits } = data;

  if (schedules.length === 0 && scheduleOtherCount === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Top Schedules</h3>
      <div className="overflow-hidden rounded-xl bg-card zero-border">
        {/* Header */}
        <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center px-5 py-2.5 text-[13px] font-medium text-foreground">
          <span>Schedule</span>
          <span>{metric === "credits" ? "Credits" : "Tokens"}</span>
        </div>
        {schedules.map((row) => {
          return (
            <div key={row.scheduleId}>
              <div className="h-0 zero-border-t mx-5" />
              <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center px-5 py-3">
                <span className="truncate text-sm text-foreground">
                  {row.scheduleName}
                </span>
                <span className="text-[13px] tabular-nums text-foreground whitespace-nowrap">
                  {metric === "credits"
                    ? formatValue(row.credits)
                    : formatValue(row.tokens)}
                </span>
              </div>
            </div>
          );
        })}
        {scheduleOtherCount > 0 && (
          <div>
            <div className="h-0 zero-border-t mx-5" />
            <div className="grid grid-cols-[1fr_auto] gap-x-4 items-center px-5 py-3">
              <span className="text-sm text-muted-foreground">
                +{scheduleOtherCount} more schedules
              </span>
              {metric === "credits" && (
                <span className="text-[13px] tabular-nums text-muted-foreground whitespace-nowrap">
                  {formatValue(scheduleOtherCredits)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
