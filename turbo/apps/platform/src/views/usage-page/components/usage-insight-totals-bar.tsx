import {
  SOURCE_BUCKET_COLORS,
  type SourceBucket,
} from "@vm0/core/usage-source-bucket";
import type {
  UsageInsightBucket,
  UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import type {
  InsightGroupBy,
  InsightMetric,
  InsightRange,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import { getCardPalette } from "../../../lib/card-palette.ts";

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
  const { bg, accent } = getCardPalette(0);

  return (
    <section
      className={`${bg} rounded-[20px] p-6 border border-border/40 break-inside-avoid`}
    >
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        {totalLabel}
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {formatTotal(total)}
      </p>
      <p className="text-sm opacity-60 mt-2">{rangeLabel}</p>
      <div
        className="mt-5 flex h-2.5 w-full overflow-hidden rounded-full bg-foreground/5"
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
      {total > 0 && sortedKeys.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {sortedKeys.map((key, i) => {
            const value = perKey.get(key) ?? 0;
            const pct = total > 0 ? Math.round((value / total) * 100) : 0;
            return (
              <li
                key={key}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: colorForKey(key, i, groupBy) }}
                />
                <span className="truncate max-w-[140px]">{key}</span>
                <span className="tabular-nums opacity-70">{pct}%</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
