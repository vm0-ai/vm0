import { computed, state, command } from "ccstate";
import { zeroUsageInsightContract } from "@vm0/api-contracts/contracts/zero-usage-insight";
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
  return result.body;
});
