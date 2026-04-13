import { useLoadable, useGet, useSet } from "ccstate-react";
import {
  dailyCreditsAsync$,
  chartMode$,
  setChartMode$,
  datePreset$,
  setDatePreset$,
  chartTooltip$,
  setChartTooltip$,
  chartWidth$,
  setChartWidth$,
  selectedMember$,
  toggleSelectedMember$,
  hoveredMember$,
  setHoveredMember$,
  chartType$,
  setChartType$,
  type ChartMode,
  type ChartType,
  type DatePreset,
  type ChartTooltipData,
} from "../../../signals/usage-page/usage-signals.ts";
import type { DailyCredit, DailyCreditByMember } from "@vm0/core";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

// --- Constants ---

const CHART_PADDING = { top: 20, right: 16, bottom: 32, left: 60 } as const;
const CHART_HEIGHT = 220;
const MEMBER_COLORS = [
  "hsl(var(--primary))",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#84cc16",
] as const;
const MAX_MEMBER_LINES = 7;

// --- Helpers ---

function formatCredits(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return String(n);
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso);
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
  // Always leave one step of headroom above max so peak values don't touch
  // the top edge of the drawing area (which would clip half the stroke).
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

function getDatePresetLabel(preset: DatePreset): string {
  switch (preset) {
    case "last7": {
      return "Last 7 days";
    }
    case "last14": {
      return "Last 14 days";
    }
    case "last30": {
      return "Last 30 days";
    }
    case "period": {
      return "Billing period";
    }
  }
}

// --- Tooltip ---

const TOOLTIP_ESTIMATED_WIDTH = 200;

function ChartTooltip({
  data,
  containerWidth,
}: {
  data: ChartTooltipData;
  containerWidth: number;
}) {
  // Flip tooltip to the left side of the cursor when it would overflow the right edge.
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
        {formatDateLabel(data.date)}
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

// --- Line data types ---

interface LineData {
  label: string;
  color: string;
  points: { date: string; value: number }[];
}

// --- SVG rendering helpers ---

function renderYGrid(
  yTicks: number[],
  yScale: (v: number) => number,
  left: number,
  right: number,
) {
  return yTicks.map((tick) => {
    return (
      <g key={tick}>
        <line
          x1={left}
          y1={yScale(tick)}
          x2={right}
          y2={yScale(tick)}
          stroke="hsl(var(--border))"
          strokeDasharray={tick === 0 ? undefined : "2,3"}
          strokeWidth={tick === 0 ? 1 : 0.5}
        />
        <text
          x={left - 8}
          y={yScale(tick)}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-muted-foreground"
          fontSize={11}
        >
          {formatCredits(tick)}
        </text>
      </g>
    );
  });
}

function renderXLabels(
  dates: string[],
  xScale: (i: number) => number,
  labelInterval: number,
) {
  return dates.map((date, i) => {
    if (i % labelInterval !== 0 && i !== dates.length - 1) {
      return null;
    }
    return (
      <text
        key={date}
        x={xScale(i)}
        y={CHART_HEIGHT - 4}
        textAnchor="middle"
        className="fill-muted-foreground"
        fontSize={11}
      >
        {formatDateLabel(date)}
      </text>
    );
  });
}

function renderBars(
  lines: LineData[],
  xScale: (i: number) => number,
  yScale: (v: number) => number,
  barSlotWidth: number,
  getOpacity: (label: string) => number,
) {
  const dates =
    lines[0]?.points.map((p) => {
      return p.date;
    }) ?? [];
  const width = Math.max(2, barSlotWidth * 0.7);
  return dates.flatMap((date, dateIdx) => {
    let cumulative = 0;
    return lines.map((line) => {
      const value = line.points[dateIdx]?.value ?? 0;
      if (value <= 0) {
        return null;
      }
      const yBottom = yScale(cumulative);
      cumulative += value;
      const yTop = yScale(cumulative);
      const height = Math.max(0, yBottom - yTop);
      const cx = xScale(dateIdx);
      return (
        <rect
          key={`${line.label}-${date}`}
          x={cx - width / 2}
          y={yTop}
          width={width}
          height={height}
          fill={line.color}
          opacity={getOpacity(line.label)}
        />
      );
    });
  });
}

function renderLines(
  lines: LineData[],
  xScale: (i: number) => number,
  yScale: (v: number) => number,
  getOpacity: (label: string) => number,
) {
  return lines.map((line) => {
    const opacity = getOpacity(line.label);
    if (line.points.length === 1) {
      return (
        <circle
          key={line.label}
          cx={xScale(0)}
          cy={yScale(line.points[0]!.value)}
          r={4}
          fill={line.color}
          opacity={opacity}
        />
      );
    }
    const d = line.points
      .map((p, i) => {
        return `${i === 0 ? "M" : "L"}${xScale(i)},${yScale(p.value)}`;
      })
      .join(" ");
    return (
      <path
        key={line.label}
        d={d}
        fill="none"
        stroke={line.color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={opacity}
      />
    );
  });
}

// --- Line chart SVG ---

function computeTooltipAt(
  mx: number,
  my: number,
  dates: string[],
  visibleLines: LineData[],
  xScale: (i: number) => number,
): ChartTooltipData | null {
  if (dates.length === 0) {
    return null;
  }
  let closestIdx = 0;
  let closestDist = Infinity;
  for (let i = 0; i < dates.length; i++) {
    const dist = Math.abs(xScale(i) - mx);
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }

  const values = visibleLines.map((line) => {
    return {
      label: line.label,
      value: line.points[closestIdx]?.value ?? 0,
      color: line.color,
    };
  });

  return {
    x: xScale(closestIdx),
    y: my,
    date: dates[closestIdx]!,
    values,
  };
}

function SvgLineChart({
  lines,
  width,
  chartType,
}: {
  lines: LineData[];
  width: number;
  chartType: ChartType;
}) {
  const tooltip = useGet(chartTooltip$);
  const setTooltip = useSet(setChartTooltip$);
  const selected = useGet(selectedMember$);
  const hovered = useGet(hoveredMember$);

  // Filter down to the selected member when one is pinned; otherwise show all.
  const visibleLines =
    selected !== null
      ? lines.filter((l) => {
          return l.label === selected;
        })
      : lines;

  const getOpacity = (label: string): number => {
    if (hovered !== null && hovered !== label) {
      return 0.2;
    }
    return 1;
  };

  // In bar mode, bars stack — yMax must reflect per-day totals, not per-line.
  const pointCount = visibleLines[0]?.points.length ?? 0;
  const perDayTotals =
    chartType === "bar"
      ? Array.from({ length: pointCount }, (_, i) => {
          return visibleLines.reduce((s, l) => {
            return s + (l.points[i]?.value ?? 0);
          }, 0);
        })
      : visibleLines.flatMap((l) => {
          return l.points.map((p) => {
            return p.value;
          });
        });
  const maxValue = Math.max(...perDayTotals, 1);
  const yTicks = generateYTicks(maxValue);
  const yMax = yTicks[yTicks.length - 1] ?? maxValue;

  const dates =
    visibleLines[0]?.points.map((p) => {
      return p.date;
    }) ?? [];
  const drawW = width - CHART_PADDING.left - CHART_PADDING.right;
  const drawH = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  // Line chart: first/last points sit at the edges of the draw area.
  // Bar chart: bars are centered within slots so the first bar doesn't
  // overlap the Y axis.
  const slotWidth = dates.length > 0 ? drawW / dates.length : drawW;
  const xScale = (i: number) => {
    if (chartType === "bar") {
      return CHART_PADDING.left + (i + 0.5) * slotWidth;
    }
    return (
      CHART_PADDING.left +
      (dates.length > 1 ? (i / (dates.length - 1)) * drawW : drawW / 2)
    );
  };
  const yScale = (v: number) => {
    return CHART_PADDING.top + drawH - (v / yMax) * drawH;
  };

  const labelInterval = Math.max(
    1,
    Math.ceil(dates.length / Math.floor(drawW / 50)),
  );

  if (dates.length === 0) {
    return (
      <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
        No data for the selected period
      </div>
    );
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const tooltipData = computeTooltipAt(mx, my, dates, visibleLines, xScale);
    if (tooltipData) {
      setTooltip(tooltipData);
    }
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <div className="relative">
      <svg
        width={width}
        height={CHART_HEIGHT}
        className="select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {renderYGrid(
          yTicks,
          yScale,
          CHART_PADDING.left,
          width - CHART_PADDING.right,
        )}
        {renderXLabels(dates, xScale, labelInterval)}
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
        {chartType === "bar"
          ? renderBars(visibleLines, xScale, yScale, slotWidth, getOpacity)
          : renderLines(visibleLines, xScale, yScale, getOpacity)}
      </svg>
      {tooltip && <ChartTooltip data={tooltip} containerWidth={width} />}
    </div>
  );
}

// --- Transform data into line format ---

function toTotalLines(daily: DailyCredit[]): LineData[] {
  return [
    {
      label: "Total",
      color: "hsl(var(--primary))",
      points: daily.map((d) => {
        return { date: d.date, value: d.creditsCharged };
      }),
    },
  ];
}

function toMemberLines(dailyByMember: DailyCreditByMember[]): LineData[] {
  const memberTotals = new Map<string, { email: string; total: number }>();
  for (const day of dailyByMember) {
    for (const m of day.members) {
      const existing = memberTotals.get(m.userId);
      if (existing) {
        existing.total += m.creditsCharged;
      } else {
        memberTotals.set(m.userId, { email: m.email, total: m.creditsCharged });
      }
    }
  }

  const sorted = [...memberTotals.entries()].sort((a, b) => {
    return b[1].total - a[1].total;
  });
  const topMembers = sorted.slice(0, MAX_MEMBER_LINES);
  const topIds = new Set(
    topMembers.map(([id]) => {
      return id;
    }),
  );
  const hasOthers = sorted.length > MAX_MEMBER_LINES;

  const lines: LineData[] = topMembers.map(([userId, { email }], i) => {
    return {
      label: email,
      color: MEMBER_COLORS[i % MEMBER_COLORS.length]!,
      points: dailyByMember.map((day) => {
        const m = day.members.find((x) => {
          return x.userId === userId;
        });
        return { date: day.date, value: m?.creditsCharged ?? 0 };
      }),
    };
  });

  if (hasOthers) {
    lines.push({
      label: "Others",
      color: "hsl(var(--muted-foreground))",
      points: dailyByMember.map((day) => {
        const sum = day.members
          .filter((m) => {
            return !topIds.has(m.userId);
          })
          .reduce((acc, m) => {
            return acc + m.creditsCharged;
          }, 0);
        return { date: day.date, value: sum };
      }),
    });
  }

  return lines;
}

// --- Legend ---

function ChartLegend({ lines }: { lines: LineData[] }) {
  const selected = useGet(selectedMember$);
  const hovered = useGet(hoveredMember$);
  const toggle = useSet(toggleSelectedMember$);
  const setHovered = useSet(setHoveredMember$);

  if (lines.length <= 1) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pt-2 text-xs text-muted-foreground">
      {lines.map((line) => {
        const isSelected = selected === line.label;
        const dimmed =
          (selected !== null && !isSelected) ||
          (hovered !== null && hovered !== line.label);
        return (
          <button
            key={line.label}
            type="button"
            onClick={() => {
              toggle(line.label);
            }}
            onPointerEnter={() => {
              setHovered(line.label);
            }}
            onPointerLeave={() => {
              setHovered(null);
            }}
            className={`flex items-center gap-1.5 rounded transition-opacity hover:text-foreground ${
              dimmed ? "opacity-40" : "opacity-100"
            } ${isSelected ? "text-foreground font-medium" : ""}`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: line.color }}
            />
            <span className="truncate max-w-[120px]">{line.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// --- ResizeObserver setup via ref callback ---

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

// --- Main component ---

export function CreditsChart() {
  const loadable = useLoadable(dailyCreditsAsync$);
  const mode = useGet(chartMode$);
  const setMode = useSet(setChartMode$);
  const preset = useGet(datePreset$);
  const setPreset = useSet(setDatePreset$);
  const width = useGet(chartWidth$);
  const setWidth = useSet(setChartWidth$);
  const chartType = useGet(chartType$);
  const setType = useSet(setChartType$);

  const containerRef = useChartResizeRef(setWidth);

  const handleModeChange = (val: string) => {
    setMode(val as ChartMode);
  };

  const handlePresetChange = (val: string) => {
    setPreset(val as DatePreset);
  };

  const handleTypeChange = (val: string) => {
    setType(val as ChartType);
  };

  const isLoading = loadable.state === "loading";
  const data = loadable.state === "hasData" ? loadable.data : null;

  const lines =
    data && mode === "member"
      ? toMemberLines(data.dailyByMember)
      : data
        ? toTotalLines(data.daily)
        : [];

  return (
    <div className="zero-card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-medium text-foreground">Daily Credits</h2>
        <div className="flex items-center gap-2">
          <Select value={chartType} onValueChange={handleTypeChange}>
            <SelectTrigger className="h-8 w-[90px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="line">Line</SelectItem>
              <SelectItem value="bar">Bar</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={handleModeChange}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="total">Total</SelectItem>
              <SelectItem value="member">By Member</SelectItem>
            </SelectContent>
          </Select>
          <Select value={preset} onValueChange={handlePresetChange}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue>{getDatePresetLabel(preset)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="last7">Last 7 days</SelectItem>
              <SelectItem value="last14">Last 14 days</SelectItem>
              <SelectItem value="last30">Last 30 days</SelectItem>
              <SelectItem value="period">Billing period</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div ref={containerRef} className="w-full overflow-hidden">
        {isLoading ? (
          <div className="h-[220px] animate-pulse bg-muted/20 rounded" />
        ) : (
          <>
            <SvgLineChart lines={lines} width={width} chartType={chartType} />
            <ChartLegend lines={lines} />
          </>
        )}
      </div>
    </div>
  );
}
