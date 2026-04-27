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

export type InsightRange = "today" | "yesterday" | "7d" | "28d";
export type InsightGroupBy = "source" | "agent";

const internalRange$ = state<InsightRange>("today");
const internalGroupBy$ = state<InsightGroupBy>("source");

export const range$ = computed((get) => {
  return get(internalRange$);
});

export const groupBy$ = computed((get) => {
  return get(internalGroupBy$);
});

export const setRange$ = command(({ set }, range: InsightRange) => {
  set(internalRange$, range);
});

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
  const groupBy = get(groupBy$);
  const tz = await get(tz$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageInsightContract);
  const result = await accept(
    client.get({ query: { range, groupBy, tz } }),
    [200],
    { toast: false },
  );
  return {
    ...result.body,
    buckets: densifyBuckets(result.body.buckets, range),
  };
});

// --- Bucket densification ---
//
// The API returns sparse buckets: only timestamps where credit_usage rows
// exist. The chart positions buckets at uniform x-spacing by index, so a
// 4-day gap (Apr 2 → Apr 6) renders the same width as a 1-day gap, which
// makes the x-axis labels look irregular and skips dates with no usage.
// Filling missing days/hours with zero buckets gives a uniform x-axis where
// every expected date is represented.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function parseBucketTs(ts: string): number {
  return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z").getTime();
}

function formatBucketTs(ms: number, isHourly: boolean): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return isHourly
    ? `${yyyy}-${mm}-${dd}T${hh}:00:00.000Z`
    : `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

function densifyBuckets(
  buckets: UsageInsightResponse["buckets"],
  range: InsightRange,
): UsageInsightResponse["buckets"] {
  const isHourly = range === "today" || range === "yesterday";
  const count = isHourly ? 24 : range === "7d" ? 7 : 28;
  const stepMs = isHourly ? HOUR_MS : DAY_MS;

  // Anchor the right edge on now (truncated to bucket boundary). For
  // "yesterday" anchor on yesterday's last hour instead so today doesn't
  // bleed in.
  const nowMs = Date.now();
  let endMs = Math.floor(nowMs / stepMs) * stepMs;
  if (range === "yesterday") {
    endMs -= 24 * HOUR_MS;
  }

  const byTs = new Map<string, UsageInsightResponse["buckets"][number]>();
  for (const b of buckets) {
    byTs.set(formatBucketTs(parseBucketTs(b.ts), isHourly), b);
  }

  const dense: UsageInsightResponse["buckets"] = [];
  for (let i = count - 1; i >= 0; i--) {
    const ts = formatBucketTs(endMs - i * stepMs, isHourly);
    dense.push(byTs.get(ts) ?? { ts, series: {}, tokens: {} });
  }
  return dense;
}
