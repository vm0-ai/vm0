import { computed, state, command } from "ccstate";
import {
  zeroUsageInsightContract,
  type UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { zeroClient$ } from "../api-client.ts";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import { accept } from "../../lib/accept.ts";

// --- Chart tooltip / width state (used by UsageInsightBarChart) ---

export interface ChartTooltipData {
  x: number;
  y: number;
  ts: string;
  values: { label: string; value: number; color: string }[];
}

const internalChartTooltip$ = state<ChartTooltipData | null>(null);
const internalChartWidth$ = state(600);

export const chartTooltip$ = computed((get) => {
  return get(internalChartTooltip$);
});

export const chartWidth$ = computed((get) => {
  return get(internalChartWidth$);
});

export const setChartTooltip$ = command(
  ({ set }, data: ChartTooltipData | null) => {
    set(internalChartTooltip$, data);
  },
);

export const setChartWidth$ = command(({ set }, width: number) => {
  set(internalChartWidth$, width);
});

export type InsightRange = "today" | "yesterday" | "day" | "7d" | "28d" | "30d";
export type InsightGroupBy = "source" | "agent";

const internalRange$ = state<InsightRange>("today");
const internalRangeDate$ = state<string | null>(null);
const internalGroupBy$ = state<InsightGroupBy>("source");

export const range$ = computed((get) => {
  return get(internalRange$);
});

export const groupBy$ = computed((get) => {
  return get(internalGroupBy$);
});

export const setRange$ = command(({ set }, range: InsightRange) => {
  set(internalRange$, range);
  set(internalRangeDate$, null);
});

export const setRangeWithDate$ = command(
  ({ set }, range: InsightRange, date: string | null) => {
    set(internalRange$, range);
    set(internalRangeDate$, date);
  },
);

export const setGroupBy$ = command(({ set }, groupBy: InsightGroupBy) => {
  set(internalGroupBy$, groupBy);
});

// --- Hover state (shared dim-on-hover behavior across breakdown lists) ---

const internalHoveredCategory$ = state<string | null>(null);
const internalHoveredScheduleId$ = state<string | null>(null);
const internalHoveredChatId$ = state<string | null>(null);

export const hoveredCategory$ = computed((get) => {
  return get(internalHoveredCategory$);
});

export const hoveredScheduleId$ = computed((get) => {
  return get(internalHoveredScheduleId$);
});

export const hoveredChatId$ = computed((get) => {
  return get(internalHoveredChatId$);
});

export const setHoveredCategory$ = command(({ set }, key: string | null) => {
  set(internalHoveredCategory$, key);
});

export const setHoveredScheduleId$ = command(({ set }, id: string | null) => {
  set(internalHoveredScheduleId$, id);
});

export const setHoveredChatId$ = command(({ set }, id: string | null) => {
  set(internalHoveredChatId$, id);
});

const tz$ = computed(async (get) => {
  const prefs = await get(userPreferences$);
  return prefs.timezone ?? "UTC";
});

export const usageInsightAsync$ = computed(async (get) => {
  const range = get(range$);
  const date = get(internalRangeDate$);
  const groupBy = get(groupBy$);
  const tz = await get(tz$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageInsightContract);
  const result = await accept(
    client.get({
      query: {
        range,
        ...(range === "day" && date ? { date } : {}),
        groupBy,
        tz,
      },
    }),
    [200],
    { toast: false },
  );
  return {
    ...result.body,
    buckets: densifyBuckets(result.body.buckets, range, tz, date),
  };
});

// --- Bucket densification ---
//
// The API returns sparse buckets: only timestamps where usage_event rows
// exist. The chart positions buckets at uniform x-spacing by index, so a
// 4-day gap (Apr 2 → Apr 6) renders the same width as a 1-day gap, which
// makes the x-axis labels look irregular and skips dates with no usage.
// Filling missing days/hours with zero buckets gives a uniform x-axis where
// every expected date is represented.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface BucketParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

const BUCKET_TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/;

function bucketPartsFromString(ts: string): BucketParts | null {
  const match = BUCKET_TS_RE.exec(ts);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] ?? "00"),
    };
  }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
  };
}

function bucketPartsInTz(ms: number, tz: string): BucketParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    return Number(
      parts.find((part) => {
        return part.type === type;
      })?.value ?? 0,
    );
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
  };
}

function formatBucketTsFromParts(
  parts: BucketParts,
  isHourly: boolean,
): string {
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const hh = String(isHourly ? parts.hour : 0).padStart(2, "0");
  return isHourly
    ? `${yyyy}-${mm}-${dd}T${hh}:00:00.000Z`
    : `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

function formatBucketTs(ms: number, isHourly: boolean): string {
  const d = new Date(ms);
  return formatBucketTsFromParts(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
    },
    isHourly,
  );
}

function normalizeBucketTs(ts: string, isHourly: boolean): string | null {
  const parts = bucketPartsFromString(ts);
  return parts ? formatBucketTsFromParts(parts, isHourly) : null;
}

function densifyBuckets(
  buckets: UsageInsightResponse["buckets"],
  range: InsightRange,
  tz: string,
  date: string | null,
): UsageInsightResponse["buckets"] {
  const isHourly =
    range === "today" || range === "yesterday" || range === "day";
  const count = isHourly ? 24 : range === "7d" ? 7 : range === "28d" ? 28 : 30;
  const stepMs = isHourly ? HOUR_MS : DAY_MS;
  const nowParts = bucketPartsInTz(Date.now(), tz);
  const todayStartMs = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day,
  );
  const startMs =
    range === "day" && date
      ? Date.parse(`${date}T00:00:00.000Z`)
      : range === "today"
        ? todayStartMs
        : range === "yesterday"
          ? todayStartMs - DAY_MS
          : todayStartMs - (count - 1) * DAY_MS;

  const byTs = new Map<string, UsageInsightResponse["buckets"][number]>();
  for (const b of buckets) {
    const key = normalizeBucketTs(b.ts, isHourly);
    if (key) {
      byTs.set(key, b);
    }
  }

  const dense: UsageInsightResponse["buckets"] = [];
  for (let i = 0; i < count; i++) {
    const ts = formatBucketTs(startMs + i * stepMs, isHourly);
    dense.push(byTs.get(ts) ?? { ts, series: {}, tokens: {} });
  }
  return dense;
}
