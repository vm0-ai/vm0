import { command, computed, state } from "ccstate";
import { zeroInsightsContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

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
  name: string;
  credits: number;
  agentNames: string[];
  agentCredits?: Record<string, number>;
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
}

export interface NetworkInsightsData {
  days: DayInsight[];
  totalCredits: number;
  totalRuns: number;
}

// ---------------------------------------------------------------------------
// UI state signals
// ---------------------------------------------------------------------------

/** Page-level date range filter */
const internalDateRange$ = state<string>("last7");

export const insightsDateRange$ = computed((get) => {
  return get(internalDateRange$);
});

export const setInsightsDateRange$ = command(({ set }, range: string) => {
  set(internalDateRange$, range);
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

/** Always fetch 30 days; display filtering is handled by the UI. */
export const networkInsightsData$ = computed(
  async (get): Promise<NetworkInsightsData> => {
    const client = get(zeroClient$)(zeroInsightsContract);
    const result = await client.get({ query: { days: 30 } });
    if (result.status !== 200) {
      throw new Error(`Failed to fetch insights: ${result.status}`);
    }
    return result.body as NetworkInsightsData;
  },
);
