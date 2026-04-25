import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import type { InsightMetric } from "../../../signals/usage-page/usage-insight-signals.ts";
import { Link } from "../../router/link.tsx";
import { getCardPalette } from "../../../lib/card-palette.ts";

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
  const { bg, accent } = getCardPalette(2);

  if (schedules.length === 0 && scheduleOtherCount === 0) {
    return (
      <section
        className={`${bg} rounded-[20px] p-6 border border-border/40 break-inside-avoid`}
      >
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          Top Schedules
        </p>
        <p className="text-sm text-muted-foreground">
          No schedules used in this period
        </p>
      </section>
    );
  }

  const totalCount = schedules.length + scheduleOtherCount;
  const maxValue = Math.max(
    1,
    ...schedules.map((s) => {
      return metric === "credits" ? s.credits : s.tokens;
    }),
  );
  const valueLabel = metric === "credits" ? "Credits" : "Tokens";

  return (
    <section
      className={`${bg} rounded-[20px] p-6 border border-border/40 break-inside-avoid`}
    >
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Top Schedules
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {totalCount === 1 ? "schedule used" : "schedules used"} · {valueLabel}
      </p>
      <ul className="flex flex-col gap-2.5 mt-4">
        {schedules.map((row) => {
          const value = metric === "credits" ? row.credits : row.tokens;
          const pct = (value / maxValue) * 100;
          return (
            <li key={row.scheduleId}>
              <Link
                pathname="/schedules/:scheduleId"
                options={{ pathParams: { scheduleId: row.scheduleId } }}
                className="flex items-center gap-3 -mx-1.5 px-1.5 py-1 rounded-md transition-colors hover:bg-foreground/5"
              >
                <span className="text-sm font-medium flex-1 truncate">
                  {row.scheduleName}
                </span>
                <div className="w-20 h-1.5 rounded-full bg-foreground/10 overflow-hidden shrink-0">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: accent }}
                  />
                </div>
                <span className="text-xs tabular-nums opacity-70 shrink-0 w-12 text-right">
                  {formatValue(value)}
                </span>
              </Link>
            </li>
          );
        })}
        {scheduleOtherCount > 0 && (
          <li className="flex items-center gap-3 -mx-1.5 px-1.5 py-1">
            <span className="text-sm text-muted-foreground flex-1 truncate">
              +{scheduleOtherCount} more{" "}
              {scheduleOtherCount === 1 ? "schedule" : "schedules"}
            </span>
            {metric === "credits" && (
              <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                {formatValue(scheduleOtherCredits)}
              </span>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}
