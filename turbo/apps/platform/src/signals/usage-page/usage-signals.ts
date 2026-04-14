import { computed, state, command } from "ccstate";
import { zeroUsageMembersContract, zeroUsageDailyContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

// --- Existing member usage signal ---

export const usageMembersAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const client = createClient(zeroUsageMembersContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

// --- Tab state ---

export type UsageTab = "overview" | "daily";

const internalUsageTab$ = state<UsageTab>("overview");

export const usageTab$ = computed((get) => {
  return get(internalUsageTab$);
});

export const setUsageTab$ = command(({ set }, tab: UsageTab) => {
  set(internalUsageTab$, tab);
});

// --- Daily credits chart signals ---

export type ChartMode = "total" | "member";
export type ChartType = "line" | "bar";

const internalChartType$ = state<ChartType>("line");

export const chartType$ = computed((get) => {
  return get(internalChartType$);
});

export const setChartType$ = command(({ set }, type: ChartType) => {
  set(internalChartType$, type);
});

const DEFAULT_PRESET_DAYS = 14;

function initialDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - DEFAULT_PRESET_DAYS);
  return { from: from.toISOString(), to: to.toISOString() };
}

const internalChartMode$ = state<ChartMode>("total");
const internalChartDateFrom$ = state<string | undefined>(
  initialDateRange().from,
);
const internalChartDateTo$ = state<string | undefined>(initialDateRange().to);

export const chartMode$ = computed((get) => {
  return get(internalChartMode$);
});

export const setChartMode$ = command(({ set }, mode: ChartMode) => {
  set(internalChartMode$, mode);
});

export type DatePreset = "last7" | "last14" | "last30" | "period";

const internalDatePreset$ = state<DatePreset>("last14");

export const datePreset$ = computed((get) => {
  return get(internalDatePreset$);
});

export const setDatePreset$ = command(({ set }, preset: DatePreset) => {
  set(internalDatePreset$, preset);
  if (preset === "period") {
    set(internalChartDateFrom$, undefined);
    set(internalChartDateTo$, undefined);
  } else {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - Number(preset.replace("last", "")));
    set(internalChartDateFrom$, from.toISOString());
    set(internalChartDateTo$, now.toISOString());
  }
});

interface ChartTooltipData {
  x: number;
  y: number;
  date: string;
  values: { label: string; value: number; color: string }[];
}

const internalChartTooltip$ = state<ChartTooltipData | null>(null);

export const chartTooltip$ = computed((get) => {
  return get(internalChartTooltip$);
});

export const setChartTooltip$ = command(
  ({ set }, data: ChartTooltipData | null) => {
    set(internalChartTooltip$, data);
  },
);

const internalChartWidth$ = state(600);

export const chartWidth$ = computed((get) => {
  return get(internalChartWidth$);
});

export const setChartWidth$ = command(({ set }, width: number) => {
  set(internalChartWidth$, width);
});

// Member line focus state (legend click selects a single member; null = show all)
const internalSelectedMember$ = state<string | null>(null);

export const selectedMember$ = computed((get) => {
  return get(internalSelectedMember$);
});

export const toggleSelectedMember$ = command(({ set, get }, label: string) => {
  const current = get(internalSelectedMember$);
  set(internalSelectedMember$, current === label ? null : label);
});

// Member line hover state (legend hover dims other lines; null = neutral)
const internalHoveredMember$ = state<string | null>(null);

export const hoveredMember$ = computed((get) => {
  return get(internalHoveredMember$);
});

export const setHoveredMember$ = command(({ set }, label: string | null) => {
  set(internalHoveredMember$, label);
});

export type { ChartTooltipData };

export const dailyCreditsAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const mode = get(internalChartMode$);
  const dateFrom = get(internalChartDateFrom$);
  const dateTo = get(internalChartDateTo$);

  const client = createClient(zeroUsageDailyContract);
  const result = await accept(
    client.get({ query: { mode, dateFrom, dateTo } }),
    [200],
  );
  return result.body;
});
