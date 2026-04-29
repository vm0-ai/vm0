import { command, computed, state } from "ccstate";
import { zeroInsightsContract } from "@vm0/api-contracts/contracts/zero-insights";
import { zeroClient$ } from "../api-client.ts";
import {
  setRange$,
  setRangeWithDate$,
  type InsightRange,
} from "../usage-page/usage-insight-signals.ts";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface AgentUsage {
  agentName: string;
  agentId: string | null;
  runs: number;
  credits: number;
}

export interface ServiceUsage {
  domain: string;
  calls: number;
  /** Which agents used this service */
  agentNames: string[];
}

export interface PermissionEntry {
  label: string;
  connectorType?: string;
  allowed: number;
  denied: number;
  /** Which agents triggered this permission */
  agentNames: string[];
}

export interface TopTask {
  name: string;
  count: number;
}

export interface MemberCredits {
  userId: string;
  name: string;
  credits: number;
  agentNames: string[];
  agentCredits?: Record<string, number>;
}

export interface DaySchedule {
  scheduleId: string;
  scheduleName: string;
  scheduleDescription: string | null;
  credits: number;
  tokens: number;
}

export interface DayChat {
  threadId: string;
  threadTitle: string | null;
  credits: number;
  tokens: number;
}

/** A single day's insight snapshot */
export interface DayInsight {
  date: string; // ISO date, e.g. "2026-04-03"
  agents: AgentUsage[];
  creditsUsed: number;
  creditBalance: number;
  teamUsage: MemberCredits[];
  topTask: TopTask | null;
  services: ServiceUsage[];
  permissions: PermissionEntry[];
  schedules: DaySchedule[];
  chats: DayChat[];
}

export interface NetworkInsightsData {
  days: DayInsight[];
  totalCredits: number;
  totalRuns: number;
  lastUpdated: string | null;
}

// ---------------------------------------------------------------------------
// UI state signals
// ---------------------------------------------------------------------------

/** Page-level date range filter */
const internalDateRange$ = state<string>("last7");

export const insightsDateRange$ = computed((get) => {
  return get(internalDateRange$);
});

/**
 * Map the page-level Insights date range to the bucket range understood by
 * the embedded Usage chart. Presets stay aligned, while a specific Insights
 * date becomes an explicit single-day Usage window.
 */
function toUsageRange(insightsRange: string): {
  range: InsightRange;
  date: string | null;
} {
  if (insightsRange === "last7") {
    return { range: "7d", date: null };
  }
  if (insightsRange === "last28") {
    return { range: "28d", date: null };
  }
  if (insightsRange === "last30") {
    return { range: "30d", date: null };
  }
  return { range: "day", date: insightsRange };
}

export const setInsightsDateRange$ = command(({ set }, range: string) => {
  set(internalDateRange$, range);
  const usageRange = toUsageRange(range);
  if (usageRange.range === "day") {
    set(setRangeWithDate$, usageRange.range, usageRange.date);
  } else {
    set(setRange$, usageRange.range);
  }
});

/**
 * Mirror the current Insights range into the Usage chart's range. Called
 * during page setup so the embedded chart fetches the correct bucket
 * window on first paint instead of the global default ("today").
 */
export const syncUsageRangeFromInsights$ = command(({ get, set }) => {
  const usageRange = toUsageRange(get(internalDateRange$));
  if (usageRange.range === "day") {
    set(setRangeWithDate$, usageRange.range, usageRange.date);
  } else {
    set(setRange$, usageRange.range);
  }
});

/** Calendar popover state */
const internalCalendarOpen$ = state(false);

export const insightsCalendarOpen$ = computed((get) => {
  return get(internalCalendarOpen$);
});

export const setInsightsCalendarOpen$ = command(({ set }, open: boolean) => {
  set(internalCalendarOpen$, open);
});

const internalCalendarYear$ = state(new Date().getFullYear());
const internalCalendarMonth$ = state(new Date().getMonth());

export const insightsCalendarYear$ = computed((get) => {
  return get(internalCalendarYear$);
});

export const insightsCalendarMonth$ = computed((get) => {
  return get(internalCalendarMonth$);
});

export const setInsightsCalendarYear$ = command(({ set }, year: number) => {
  set(internalCalendarYear$, year);
});

export const setInsightsCalendarMonth$ = command(({ set }, month: number) => {
  set(internalCalendarMonth$, month);
});

/** Hovered agent name in the insights page (for highlighting). */
const internalHoveredAgent$ = state<string | null>(null);

export const insightsHoveredAgent$ = computed((get) => {
  return get(internalHoveredAgent$);
});

export const setInsightsHoveredAgent$ = command(
  ({ set }, agent: string | null) => {
    set(internalHoveredAgent$, agent);
  },
);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const internalReloadInsights$ = state(0);

/** Always fetch 30 days; display filtering is handled by the UI. */
export const networkInsightsData$ = computed(
  async (get): Promise<NetworkInsightsData> => {
    get(internalReloadInsights$);
    const client = get(zeroClient$)(zeroInsightsContract);
    const result = await client.get({ query: { days: 30 } });
    if (result.status !== 200) {
      throw new Error(`Failed to fetch insights: ${result.status}`);
    }
    return result.body as NetworkInsightsData;
  },
);

/** Trigger a re-fetch of insights data. */
export const reloadInsights$ = command(({ set }) => {
  set(internalReloadInsights$, (x) => {
    return x + 1;
  });
});

// ---------------------------------------------------------------------------
// Active tab: daily diary vs. period-wide time-range view
// ---------------------------------------------------------------------------

export type InsightsTab = "daily" | "time-range";

const internalActiveTab$ = state<InsightsTab>("daily");

export const insightsActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const setInsightsActiveTab$ = command(({ set }, tab: InsightsTab) => {
  set(internalActiveTab$, tab);
});

// ---------------------------------------------------------------------------
// "Show all" toggle for per-day schedules / chats cards (keyed by day date)
// ---------------------------------------------------------------------------

const internalExpandedSchedules$ = state<Set<string>>(new Set());

export const expandedScheduleDays$ = computed((get) => {
  return get(internalExpandedSchedules$);
});

export const toggleExpandedScheduleDay$ = command(
  ({ get, set }, dayDate: string) => {
    const current = get(internalExpandedSchedules$);
    const next = new Set(current);
    if (next.has(dayDate)) {
      next.delete(dayDate);
    } else {
      next.add(dayDate);
    }
    set(internalExpandedSchedules$, next);
  },
);

const internalExpandedChats$ = state<Set<string>>(new Set());

export const expandedChatDays$ = computed((get) => {
  return get(internalExpandedChats$);
});

export const toggleExpandedChatDay$ = command(
  ({ get, set }, dayDate: string) => {
    const current = get(internalExpandedChats$);
    const next = new Set(current);
    if (next.has(dayDate)) {
      next.delete(dayDate);
    } else {
      next.add(dayDate);
    }
    set(internalExpandedChats$, next);
  },
);

// ---------------------------------------------------------------------------
// "Load more" toggle for allowed-permissions card (keyed by day date)
// ---------------------------------------------------------------------------

const internalExpandedAllowed$ = state<Set<string>>(new Set());

export const expandedAllowedDays$ = computed((get) => {
  return get(internalExpandedAllowed$);
});

export const toggleExpandedAllowed$ = command(
  ({ get, set }, dayDate: string) => {
    const current = get(internalExpandedAllowed$);
    const next = new Set(current);
    if (next.has(dayDate)) {
      next.delete(dayDate);
    } else {
      next.add(dayDate);
    }
    set(internalExpandedAllowed$, next);
  },
);
