import { computed, state, command } from "ccstate";
import {
  zeroUsageMembersContract,
  zeroUsageDailyContract,
  zeroUsageRunsContract,
} from "@vm0/core";
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

export type UsageTab = "overview" | "runs";

const internalUsageTab$ = state<UsageTab>("overview");

export const usageTab$ = computed((get) => {
  return get(internalUsageTab$);
});

export const setUsageTab$ = command(({ set }, tab: UsageTab) => {
  set(internalUsageTab$, tab);
});

// --- Daily credits chart signals ---

export type ChartMode = "total" | "member";

const internalChartMode$ = state<ChartMode>("total");
const internalChartDateFrom$ = state<string | undefined>(undefined);
const internalChartDateTo$ = state<string | undefined>(undefined);

export const chartMode$ = computed((get) => {
  return get(internalChartMode$);
});

export const setChartMode$ = command(({ set }, mode: ChartMode) => {
  set(internalChartMode$, mode);
});

export type DatePreset = "last7" | "last14" | "last30" | "period";

const internalDatePreset$ = state<DatePreset>("period");

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

// --- Per-run records signals ---

const internalRunsPage$ = state(1);
const internalRunsAgentFilter$ = state<string | undefined>(undefined);
const internalRunsMemberFilter$ = state<string | undefined>(undefined);
const internalRunsDateFrom$ = state<string | undefined>(undefined);
const internalRunsDateTo$ = state<string | undefined>(undefined);

export const runsPage$ = computed((get) => {
  return get(internalRunsPage$);
});

export const runsMemberFilter$ = computed((get) => {
  return get(internalRunsMemberFilter$);
});

export const setRunsPage$ = command(({ set }, page: number) => {
  set(internalRunsPage$, page);
});

export const setRunsFilter$ = command(
  (
    { set },
    filter: {
      agentId?: string;
      userId?: string;
      dateFrom?: string;
      dateTo?: string;
    },
  ) => {
    if (filter.agentId !== undefined) {
      set(internalRunsAgentFilter$, filter.agentId || undefined);
    }
    if (filter.userId !== undefined) {
      set(internalRunsMemberFilter$, filter.userId || undefined);
    }
    if (filter.dateFrom !== undefined) {
      set(internalRunsDateFrom$, filter.dateFrom || undefined);
    }
    if (filter.dateTo !== undefined) {
      set(internalRunsDateTo$, filter.dateTo || undefined);
    }
    set(internalRunsPage$, 1);
  },
);

export const usageRunsAsync$ = computed(async (get) => {
  const createClient = get(zeroClient$);
  const page = get(internalRunsPage$);
  const agentId = get(internalRunsAgentFilter$);
  const userId = get(internalRunsMemberFilter$);
  const dateFrom = get(internalRunsDateFrom$);
  const dateTo = get(internalRunsDateTo$);

  const client = createClient(zeroUsageRunsContract);
  const result = await accept(
    client.get({
      query: { page, pageSize: 20, agentId, userId, dateFrom, dateTo },
    }),
    [200],
  );
  return result.body;
});
