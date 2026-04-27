import { useGet, useSet } from "ccstate-react";
import type {
  UsageInsightBucket,
  UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import {
  chartTooltip$,
  chartWidth$,
  groupBy$,
  hoveredCategory$,
  setChartTooltip$,
  setChartWidth$,
  setGroupBy$,
  setHoveredCategory$,
  type ChartTooltipData,
  type InsightGroupBy,
  type InsightRange,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import { getCardPalette } from "../../../lib/card-palette.ts";

// --- Constants ---

const CHART_PADDING = { top: 20, right: 8, bottom: 32, left: 28 } as const;
const CHART_HEIGHT = 220;

// Rose-family shades from base to lightest. Largest category gets the base
// accent; subsequent categories step toward lighter tints so each line stays
// readable while sharing one hue.
const CATEGORY_SHADES: readonly string[] = [
  "#E24B6A", // base rose (card accent)
  "#EB7C95",
  "#F0A0B3",
  "#F4BFCB",
  "#F7D7DF",
];

function colorFor(idx: number): string {
  return CATEGORY_SHADES[idx % CATEGORY_SHADES.length]!;
}

function formatCategoryLabel(key: string): string {
  if (key.length === 0) {
    return key;
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const RANGE_LABELS = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "28d": "Last 28 days",
} as const satisfies Record<InsightRange, string>;

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

function formatTotal(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

function formatBucketLabel(ts: string, range: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/.exec(ts);
  const d = match
    ? new Date(
        Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4] ?? "0"),
        ),
      )
    : new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) {
    return ts;
  }
  if (range === "today" || range === "yesterday") {
    return String(d.getUTCHours()).padStart(2, "0");
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function niceStep(range: number, targetTicks: number): number {
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / pow;
  const nice =
    normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  // Credits/tokens are integers — keep step ≥ 1 so ticks stay distinct
  // after Math.round (otherwise small maxValues produce duplicate keys).
  return Math.max(1, nice * pow);
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

function valueAt(bucket: UsageInsightBucket, key: string): number {
  return bucket.series[key] ?? 0;
}

function buildStackOrder(buckets: UsageInsightBucket[]): {
  stackOrder: string[];
  keyTotals: Map<string, number>;
} {
  const allKeys = new Set<string>();
  for (const bucket of buckets) {
    for (const key of Object.keys(bucket.series)) {
      allKeys.add(key);
    }
  }
  const keyTotals = new Map<string, number>();
  for (const key of allKeys) {
    let sum = 0;
    for (const bucket of buckets) {
      sum += valueAt(bucket, key);
    }
    keyTotals.set(key, sum);
  }
  // Stack order: largest first (most prominent), "others" forced to last.
  const stackOrder = [...allKeys]
    .filter((k) => {
      return (keyTotals.get(k) ?? 0) > 0;
    })
    .sort((a, b) => {
      if (a === "others") {
        return 1;
      }
      if (b === "others") {
        return -1;
      }
      return (keyTotals.get(b) ?? 0) - (keyTotals.get(a) ?? 0);
    });
  return { stackOrder, keyTotals };
}

const HOVER_DIM_OPACITY = 0.15;

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

// --- Tooltip ---

const TOOLTIP_ESTIMATED_WIDTH = 200;
const TOOLTIP_ESTIMATED_HEIGHT = 90;

function ChartTooltip({
  data,
  containerWidth,
  range,
}: {
  data: ChartTooltipData;
  containerWidth: number;
  range: string;
}) {
  const flipLeft = data.x + 12 + TOOLTIP_ESTIMATED_WIDTH > containerWidth;
  const flipTop = data.y < TOOLTIP_ESTIMATED_HEIGHT;
  const left = flipLeft ? data.x - 12 : data.x + 12;
  const top = flipTop ? data.y + 12 : data.y - 8;
  const translateX = flipLeft ? "-100%" : "0";
  const translateY = flipTop ? "0" : "-100%";
  // Lines are drawn per-category from y=0 (not stacked), so a synthetic Total
  // wouldn't correspond to anything visible. List per-category values that
  // match the dots on each line.
  const breakdown = data.values.filter((v) => {
    return v.value > 0;
  });

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
      style={{
        left,
        top,
        transform: `translate(${translateX}, ${translateY})`,
      }}
    >
      <div className="font-medium text-foreground mb-1">
        {formatBucketLabel(data.ts, range)}
      </div>
      {breakdown.length === 0 ? (
        <div className="text-muted-foreground">No usage</div>
      ) : (
        breakdown.map((v) => {
          return (
            <div key={v.label} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: v.color }}
              />
              <span className="text-muted-foreground">
                {formatCategoryLabel(v.label)}:
              </span>
              <span className="font-medium tabular-nums text-foreground">
                {v.value.toLocaleString()}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

// --- Chart SVG body ---

interface ChartScales {
  xScale: (i: number) => number;
  yScale: (v: number) => number;
  drawH: number;
  yTicks: number[];
  labelInterval: number;
}

function buildScales(
  buckets: UsageInsightBucket[],
  stackOrder: readonly string[],
  width: number,
): ChartScales {
  // Y-axis fits the largest single-category value so each line is readable
  // even when other categories swamp the cumulative total.
  let maxValue = 1;
  for (const bucket of buckets) {
    for (const key of stackOrder) {
      const v = valueAt(bucket, key);
      if (v > maxValue) {
        maxValue = v;
      }
    }
  }
  const yTicks = generateYTicks(maxValue);
  const yMax = yTicks[yTicks.length - 1] ?? maxValue;
  const drawW = width - CHART_PADDING.left - CHART_PADDING.right;
  const drawH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const spacing = buckets.length > 1 ? drawW / (buckets.length - 1) : 0;
  return {
    xScale: (i: number) => {
      if (buckets.length <= 1) {
        return CHART_PADDING.left + drawW / 2;
      }
      return CHART_PADDING.left + i * spacing;
    },
    yScale: (v: number) => {
      return CHART_PADDING.top + drawH - (v / yMax) * drawH;
    },
    drawH,
    yTicks,
    labelInterval: Math.max(
      1,
      Math.ceil(buckets.length / Math.floor(drawW / 50)),
    ),
  };
}

function ChartGrid({
  buckets,
  width,
  range,
  scales,
}: {
  buckets: UsageInsightBucket[];
  width: number;
  range: string;
  scales: ChartScales;
}) {
  const { xScale, yScale, yTicks, labelInterval } = scales;
  const lastIdx = buckets.length - 1;
  return (
    <>
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
              x={0}
              y={yScale(tick)}
              textAnchor="start"
              dominantBaseline="middle"
              className="fill-muted-foreground"
              fontSize={11}
            >
              {formatValue(tick)}
            </text>
          </g>
        );
      })}
      {buckets.map((bucket, i) => {
        const isLast = i === lastIdx;
        if (!isLast) {
          if (i % labelInterval !== 0) {
            return null;
          }
          // Drop the regular-interval label if it would visually collide
          // with the always-shown last label.
          if (lastIdx - i < labelInterval) {
            return null;
          }
        }
        const anchor = i === 0 ? "start" : isLast ? "end" : "middle";
        return (
          <text
            key={bucket.ts}
            x={xScale(i)}
            y={CHART_HEIGHT - 4}
            textAnchor={anchor}
            className="fill-muted-foreground"
            fontSize={11}
          >
            {formatBucketLabel(bucket.ts, range)}
          </text>
        );
      })}
    </>
  );
}

function ChartLayers({
  buckets,
  stackOrder,
  scales,
  hoveredKey,
}: {
  buckets: UsageInsightBucket[];
  stackOrder: readonly string[];
  scales: ChartScales;
  hoveredKey: string | null;
}) {
  const { xScale, yScale, drawH } = scales;
  const baselineY = CHART_PADDING.top + drawH;
  const lastIdx = buckets.length - 1;
  const renderPaths = buckets.length > 1;

  return (
    <>
      {stackOrder.map((key, i) => {
        const hue = colorFor(i);
        const isHovered = hoveredKey === key;
        const dimmed = hoveredKey !== null && !isHovered;
        const fillOpacity = isHovered ? 0.32 : dimmed ? 0.04 : 0.18;
        const lineOpacity = isHovered ? 1 : dimmed ? HOVER_DIM_OPACITY : 0.85;
        const points = buckets
          .map((b, t) => {
            return `${xScale(t)},${yScale(valueAt(b, key))}`;
          })
          .join(" L");
        return (
          <g key={key}>
            {renderPaths && (
              <path
                d={`M${xScale(0)},${baselineY} L${points} L${xScale(lastIdx)},${baselineY} Z`}
                fill={hue}
                fillOpacity={fillOpacity}
                className="transition-opacity duration-150"
              />
            )}
            {renderPaths && (
              <path
                d={`M${points}`}
                fill="none"
                stroke={hue}
                strokeWidth={isHovered ? 2.5 : 1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={lineOpacity}
                className="transition-opacity duration-150"
              />
            )}
            {buckets.map((bucket, t) => {
              const v = valueAt(bucket, key);
              if (v === 0) {
                return null;
              }
              return (
                <circle
                  key={bucket.ts}
                  cx={xScale(t)}
                  cy={yScale(v)}
                  r={isHovered ? 4 : buckets.length === 1 ? 5 : 3}
                  fill={hue}
                  opacity={lineOpacity}
                  className="transition-opacity duration-150"
                />
              );
            })}
          </g>
        );
      })}
    </>
  );
}

function ChartSvg({
  buckets,
  stackOrder,
  width,
  range,
  hoveredKey,
  tooltip,
  onMouseMove,
  onMouseLeave,
}: {
  buckets: UsageInsightBucket[];
  stackOrder: readonly string[];
  width: number;
  range: string;
  hoveredKey: string | null;
  tooltip: ChartTooltipData | null;
  onMouseMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  onMouseLeave: () => void;
}) {
  const scales = buildScales(buckets, stackOrder, width);
  return (
    <svg
      width={width}
      height={CHART_HEIGHT}
      className="select-none"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <ChartGrid
        buckets={buckets}
        width={width}
        range={range}
        scales={scales}
      />
      {tooltip && (
        <line
          x1={tooltip.x}
          y1={CHART_PADDING.top}
          x2={tooltip.x}
          y2={CHART_PADDING.top + scales.drawH}
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={1}
          strokeDasharray="3,3"
          opacity={0.5}
        />
      )}
      <ChartLayers
        buckets={buckets}
        stackOrder={stackOrder}
        scales={scales}
        hoveredKey={hoveredKey}
      />
    </svg>
  );
}

// --- Main component ---

export function UsageInsightBarChart({
  data,
  range,
}: {
  data: UsageInsightResponse;
  range: InsightRange;
}) {
  const width = useGet(chartWidth$);
  const setWidth = useSet(setChartWidth$);
  const tooltip = useGet(chartTooltip$);
  const setTooltip = useSet(setChartTooltip$);
  const hoveredKey = useGet(hoveredCategory$);
  const setHoveredKey = useSet(setHoveredCategory$);
  const groupBy = useGet(groupBy$);
  const setGroupBy = useSet(setGroupBy$);

  const containerRef = useChartResizeRef(setWidth);

  const { accent } = getCardPalette(1);
  const { buckets } = data;
  const total = data.grandTotalCredits;
  const rangeLabel = RANGE_LABELS[range];

  const { stackOrder, keyTotals } = buildStackOrder(buckets);

  const drawW = width - CHART_PADDING.left - CHART_PADDING.right;
  const spacing = buckets.length > 1 ? drawW / (buckets.length - 1) : 0;

  const xScale = (i: number) => {
    if (buckets.length <= 1) {
      return CHART_PADDING.left + drawW / 2;
    }
    return CHART_PADDING.left + i * spacing;
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

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
    if (!bucket) {
      return;
    }

    const values = stackOrder.map((key, i) => {
      return {
        label: key,
        value: valueAt(bucket, key),
        color: colorFor(i),
      };
    });

    setTooltip({ x: xScale(closestIdx), y: my, ts: bucket.ts, values });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <section
      aria-label="Credits totals"
      className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid relative"
    >
      {buckets.length > 0 && total > 0 && (
        <div className="absolute top-6 right-6">
          <GroupByToggle groupBy={groupBy} setGroupBy={setGroupBy} />
        </div>
      )}

      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        credits
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {formatTotal(total)}
      </p>
      <p className="text-sm opacity-60 mt-4">{rangeLabel}</p>

      {buckets.length > 0 && total > 0 && (
        <div className="relative mt-5">
          <div ref={containerRef} className="w-full overflow-hidden">
            <ChartSvg
              buckets={buckets}
              stackOrder={stackOrder}
              width={width}
              range={range}
              hoveredKey={hoveredKey}
              tooltip={tooltip}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            />
          </div>
          {tooltip && (
            <ChartTooltip data={tooltip} containerWidth={width} range={range} />
          )}
        </div>
      )}

      {stackOrder.length > 1 && total > 0 && (
        <BreakdownList
          stackOrder={stackOrder}
          keyTotals={keyTotals}
          total={total}
          hoveredKey={hoveredKey}
          setHoveredKey={setHoveredKey}
        />
      )}
    </section>
  );
}

function GroupByToggle({
  groupBy,
  setGroupBy,
}: {
  groupBy: InsightGroupBy;
  setGroupBy: (value: InsightGroupBy) => void;
}) {
  return (
    <Tabs
      value={groupBy}
      onValueChange={(v) => {
        setGroupBy(v as InsightGroupBy);
      }}
    >
      <TabsList className="zero-tabs h-8 gap-1 px-1 py-1">
        <TabsTrigger value="source" className="px-3 text-xs">
          Source
        </TabsTrigger>
        <TabsTrigger value="agent" className="px-3 text-xs">
          Agent
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function BreakdownList({
  stackOrder,
  keyTotals,
  total,
  hoveredKey,
  setHoveredKey,
}: {
  stackOrder: readonly string[];
  keyTotals: Map<string, number>;
  total: number;
  hoveredKey: string | null;
  setHoveredKey: (key: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 mt-4">
      {stackOrder.map((key, i) => {
        const value = keyTotals.get(key) ?? 0;
        const pct = total > 0 ? (value / total) * 100 : 0;
        const isActive = hoveredKey === null || hoveredKey === key;
        const hue = colorFor(i);
        return (
          <div
            key={key}
            className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 rounded-md px-1.5 py-0.5 -mx-1.5 cursor-default transition-all duration-150 ${
              hoveredKey === key ? "bg-foreground/5" : ""
            } ${isActive ? "opacity-100" : "opacity-30"}`}
            onMouseEnter={() => {
              setHoveredKey(key);
            }}
            onMouseLeave={() => {
              setHoveredKey(null);
            }}
          >
            <span className="text-sm font-medium truncate decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
              {formatCategoryLabel(key)}
            </span>
            <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: hue }}
              />
            </div>
            <span className="text-xs tabular-nums opacity-70 text-right">
              {formatValue(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
