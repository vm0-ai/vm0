import {
  SOURCE_BUCKET_COLORS,
  type SourceBucket,
} from "@vm0/core/usage-source-bucket";
import type {
  UsageInsightBucket,
  UsageInsightResponse,
} from "@vm0/core/contracts/zero-usage-insight";
import type {
  InsightGroupBy,
  InsightMetric,
  InsightRange,
} from "../../../signals/usage-page/usage-insight-signals.ts";

const AGENT_COLORS = [
  "hsl(var(--primary))",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#84cc16",
] as const;

const RANGE_LABELS = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "28d": "Last 28 days",
} as const satisfies Record<InsightRange, string>;

function formatTotal(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

function colorForKey(
  key: string,
  index: number,
  groupBy: InsightGroupBy,
): string {
  if (groupBy === "source") {
    return (
      SOURCE_BUCKET_COLORS[key as SourceBucket] ??
      "hsl(var(--muted-foreground))"
    );
  }
  return AGENT_COLORS[index % AGENT_COLORS.length]!;
}

function sumBuckets(
  buckets: UsageInsightBucket[],
  metric: InsightMetric,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    const entries = metric === "credits" ? bucket.series : bucket.tokens;
    for (const [key, value] of Object.entries(entries)) {
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  }
  return totals;
}

export function UsageInsightTotalsBar({
  data,
  metric,
  groupBy,
  range,
}: {
  data: UsageInsightResponse;
  metric: InsightMetric;
  groupBy: InsightGroupBy;
  range: InsightRange;
}) {
  const total =
    metric === "credits" ? data.grandTotalCredits : data.grandTotalTokens;
  const perKey = sumBuckets(data.buckets, metric);
  const sortedKeys = [...perKey.keys()]
    .filter((k) => {
      return (perKey.get(k) ?? 0) > 0;
    })
    .sort((a, b) => {
      if (a === "others") {
        return 1;
      }
      if (b === "others") {
        return -1;
      }
      return (perKey.get(b) ?? 0) - (perKey.get(a) ?? 0);
    });

  const totalLabel = metric === "credits" ? "credits" : "tokens";
  const rangeLabel = RANGE_LABELS[range];

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col">
          <div className="text-2xl font-semibold tabular-nums text-foreground">
            {formatTotal(total)}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {totalLabel}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">{rangeLabel}</div>
        </div>
      </div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Total ${totalLabel} breakdown`}
      >
        {total > 0 &&
          sortedKeys.map((key, i) => {
            const value = perKey.get(key) ?? 0;
            const pct = (value / total) * 100;
            return (
              <div
                key={key}
                style={{
                  width: `${pct}%`,
                  backgroundColor: colorForKey(key, i, groupBy),
                }}
                title={`${key}: ${value.toLocaleString()}`}
              />
            );
          })}
      </div>
    </section>
  );
}
