import { useGet, useSet } from "ccstate-react";
import { state, command, computed } from "ccstate";
import { SOURCE_BUCKET_COLORS, type SourceBucket } from "@vm0/core";
import type { UsageInsightBucket } from "@vm0/core";
import type {
  InsightMetric,
  InsightGroupBy,
} from "../../../signals/usage-page/usage-insight-signals.ts";

// --- Constants ---

const CHART_PADDING = { top: 20, right: 16, bottom: 32, left: 60 } as const;
const CHART_HEIGHT = 220;

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

// --- Module-level state ---

interface TooltipData {
  x: number;
  y: number;
  ts: string;
  values: { label: string; value: number; color: string }[];
}

const internalTooltip$ = state<TooltipData | null>(null);
const internalWidth$ = state(600);

const setTooltip$ = command(({ set }, data: TooltipData | null) => {
  set(internalTooltip$, data);
});

const setChartWidth$ = command(({ set }, width: number) => {
  set(internalWidth$, width);
});

const tooltip$ = computed((get) => {
  return get(internalTooltip$);
});
const chartWidth$ = computed((get) => {
  return get(internalWidth$);
});

// --- Helpers ---

function formatValue(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return String(n);
}

function formatBucketLabel(ts: string, range: string): string {
  // Parse the ts string (format: "2026-04-19 00:00:00" or "2026-04-19T00:00:00.000Z")
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return ts;
  if (range === "24h") {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function niceStep(range: number, targetTicks: number): number {
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / pow;
  const nice =
    normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return nice * pow;
}

function generateYTicks(max: number): number[] {
  if (max <= 0) {
    return [0];
  }
  const step = niceStep(max, 4);
  const top = Math.floor(max / step) * step + step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step * 0.01; v += step) {
    ticks.push(Math.round(v));
  }
  if (ticks.length < 2) {
    ticks.push(Math.round(max));
  }
  return ticks;
}

// --- Color assignment ---

function assignColors(
  keys: string[],
  groupBy: InsightGroupBy,
): Map<string, string> {
  const colorMap = new Map<string, string>();
  if (groupBy === "source") {
    for (const key of keys) {
      colorMap.set(
        key,
        SOURCE_BUCKET_COLORS[key as SourceBucket] ??
          "hsl(var(--muted-foreground))",
      );
    }
  } else {
    keys.forEach((key, i) => {
      colorMap.set(key, AGENT_COLORS[i % AGENT_COLORS.length]!);
    });
  }
  return colorMap;
}

// --- Resize observer ---

function useChartResizeRef(setWidth: (w: number) => void) {
  let observer: ResizeObserver | null = null;
  return (el: HTMLDivElement | null) => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (el) {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          setWidth(entry.contentRect.width);
        }
      });
      observer.observe(el);
    }
  };
}

// --- Tooltip component ---

const TOOLTIP_ESTIMATED_WIDTH = 200;

function ChartTooltip({
  data,
  containerWidth,
  range,
}: {
  data: TooltipData;
  containerWidth: number;
  range: string;
}) {
  const flipLeft = data.x + 12 + TOOLTIP_ESTIMATED_WIDTH > containerWidth;
  const left = flipLeft ? data.x - 12 : data.x + 12;
  const translateX = flipLeft ? "-100%" : "0";

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
      style={{
        left,
        top: data.y - 8,
        transform: `translate(${translateX}, -100%)`,
      }}
    >
      <div className="font-medium text-foreground mb-1">
        {formatBucketLabel(data.ts, range)}
      </div>
      {data.values.map((v) => {
        return (
          <div key={v.label} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: v.color }}
            />
            <span className="text-muted-foreground">{v.label}:</span>
            <span className="font-medium tabular-nums text-foreground">
              {v.value.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// --- Main chart component ---

export function UsageInsightBarChart({
  buckets,
  metric,
  groupBy,
  range,
}: {
  buckets: UsageInsightBucket[];
  metric: InsightMetric;
  groupBy: InsightGroupBy;
  range: string;
}) {
  const width = useGet(chartWidth$);
  const setWidth = useSet(setChartWidth$);
  const tooltip = useGet(tooltip$);
  const setTooltip = useSet(setTooltip$);

  const containerRef = useChartResizeRef(setWidth);

  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
        No data for the selected period
      </div>
    );
  }

  // Collect all unique series keys across all buckets
  const allKeys = new Set<string>();
  for (const bucket of buckets) {
    for (const key of Object.keys(
      metric === "credits" ? bucket.series : bucket.tokens,
    )) {
      allKeys.add(key);
    }
  }

  // Sort keys: "others" last
  const sortedKeys = [...allKeys].sort((a, b) => {
    if (a === "others") return 1;
    if (b === "others") return -1;
    return a.localeCompare(b);
  });

  const colorMap = assignColors(sortedKeys, groupBy);

  // Compute per-bucket totals for Y axis
  const perBucketTotals = buckets.map((b) => {
    return Object.values(metric === "credits" ? b.series : b.tokens).reduce(
      (s, v) => {
        return s + v;
      },
      0,
    );
  });
  const maxValue = Math.max(...perBucketTotals, 1);
  const yTicks = generateYTicks(maxValue);
  const yMax = yTicks[yTicks.length - 1] ?? maxValue;

  const drawW = width - CHART_PADDING.left - CHART_PADDING.right;
  const drawH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const slotWidth = buckets.length > 0 ? drawW / buckets.length : drawW;

  const xScale = (i: number) => {
    return CHART_PADDING.left + (i + 0.5) * slotWidth;
  };

  const yScale = (v: number) => {
    return CHART_PADDING.top + drawH - (v / yMax) * drawH;
  };

  const labelInterval = Math.max(
    1,
    Math.ceil(buckets.length / Math.floor(drawW / 50)),
  );

  const barWidth = Math.max(2, slotWidth * 0.7);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Find closest bucket
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < buckets.length; i++) {
      const dist = Math.abs(xScale(i) - mx);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }

    const bucket = buckets[closestIdx];
    if (!bucket) return;

    const values = sortedKeys.map((key) => {
      const val =
        metric === "credits"
          ? (bucket.series[key] ?? 0)
          : (bucket.tokens[key] ?? 0);
      return { label: key, value: val, color: colorMap.get(key) ?? "#888" };
    });

    setTooltip({ x: xScale(closestIdx), y: my, ts: bucket.ts, values });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <div className="zero-card p-4">
      <div ref={containerRef} className="w-full overflow-hidden">
        <div className="relative">
          <svg
            width={width}
            height={CHART_HEIGHT}
            className="select-none"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            {/* Y axis grid + labels */}
            {yTicks.map((tick) => {
              return (
                <g key={tick}>
                  <line
                    x1={CHART_PADDING.left}
                    y1={yScale(tick)}
                    x2={width - CHART_PADDING.right}
                    y2={yScale(tick)}
                    stroke="hsl(var(--border))"
                    strokeDasharray={tick === 0 ? undefined : "2,3"}
                    strokeWidth={tick === 0 ? 1 : 0.5}
                  />
                  <text
                    x={CHART_PADDING.left - 8}
                    y={yScale(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-muted-foreground"
                    fontSize={11}
                  >
                    {formatValue(tick)}
                  </text>
                </g>
              );
            })}

            {/* X axis labels */}
            {buckets.map((bucket, i) => {
              if (i % labelInterval !== 0 && i !== buckets.length - 1) {
                return null;
              }
              return (
                <text
                  key={bucket.ts}
                  x={xScale(i)}
                  y={CHART_HEIGHT - 4}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  fontSize={11}
                >
                  {formatBucketLabel(bucket.ts, range)}
                </text>
              );
            })}

            {/* Tooltip vertical line */}
            {tooltip && (
              <line
                x1={tooltip.x}
                y1={CHART_PADDING.top}
                x2={tooltip.x}
                y2={CHART_PADDING.top + drawH}
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1}
                strokeDasharray="3,3"
                opacity={0.5}
              />
            )}

            {/* Stacked bars */}
            {buckets.flatMap((bucket, bucketIdx) => {
              let cumulative = 0;
              return sortedKeys.map((key) => {
                const value =
                  metric === "credits"
                    ? (bucket.series[key] ?? 0)
                    : (bucket.tokens[key] ?? 0);
                if (value <= 0) return null;

                const yBottom = yScale(cumulative);
                cumulative += value;
                const yTop = yScale(cumulative);
                const height = Math.max(0, yBottom - yTop);
                const cx = xScale(bucketIdx);

                return (
                  <rect
                    key={`${key}-${bucket.ts}`}
                    x={cx - barWidth / 2}
                    y={yTop}
                    width={barWidth}
                    height={height}
                    fill={colorMap.get(key) ?? "#888"}
                  />
                );
              });
            })}
          </svg>
          {tooltip && (
            <ChartTooltip data={tooltip} containerWidth={width} range={range} />
          )}
        </div>

        {/* Legend */}
        {sortedKeys.length > 1 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pt-2 text-xs text-muted-foreground">
            {sortedKeys.map((key) => {
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: colorMap.get(key) }}
                  />
                  <span className="truncate max-w-[120px]">{key}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
