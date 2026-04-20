import { computed, state, command } from "ccstate";
import { zeroUsageInsightContract } from "@vm0/core";
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

export type InsightRange = "24h" | "7d" | "28d";
export type InsightGroupBy = "source" | "agent";
export type InsightMetric = "credits" | "tokens";
export type InsightDetailTab = "schedules" | "chats";

const internalRange$ = state<InsightRange>("7d");
const internalGroupBy$ = state<InsightGroupBy>("source");
const internalMetric$ = state<InsightMetric>("credits");
const internalDetailTab$ = state<InsightDetailTab>("schedules");

export const range$ = computed((get) => {
  return get(internalRange$);
});

export const groupBy$ = computed((get) => {
  return get(internalGroupBy$);
});

export const metric$ = computed((get) => {
  return get(internalMetric$);
});

export const detailTab$ = computed((get) => {
  return get(internalDetailTab$);
});

export const setRange$ = command(({ set }, range: InsightRange) => {
  set(internalRange$, range);
});

export const setGroupBy$ = command(({ set }, groupBy: InsightGroupBy) => {
  set(internalGroupBy$, groupBy);
});

export const setMetric$ = command(({ set }, metric: InsightMetric) => {
  set(internalMetric$, metric);
});

export const setDetailTab$ = command(({ set }, tab: InsightDetailTab) => {
  set(internalDetailTab$, tab);
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
  return result.body;
});
