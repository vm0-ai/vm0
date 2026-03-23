import { command, computed, state, type Computed } from "ccstate";
import type {
  LogDetail,
  AgentEvent,
  AgentEventsResponse,
  LogStatus,
} from "../zero-page/log-types.ts";
import type { ComposeListItem } from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { createCursorPagination } from "../cursor-pagination.ts";
import { throwIfAbort, detach, Reason } from "../utils.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { delay } from "signal-timers";

const EVENTS_PAGE_LIMIT = 30;
const MAX_POLL_INTERVAL = 30_000;

// ---------------------------------------------------------------------------
// Filters — URL-derived
// ---------------------------------------------------------------------------

/** Agent filter derived from URL `?agent=` query param. */
export const zeroActivityAgentFilter$ = computed((get) => {
  return get(searchParams$).get("agent") ?? "all";
});

/** Status filter derived from URL `?status=` query param. */
export const zeroActivityStatusFilter$ = computed((get) => {
  return get(searchParams$).get("status") ?? "all";
});

/** Source filter derived from URL `?source=` query param. */
export const zeroActivitySourceFilter$ = computed((get) => {
  return get(searchParams$).get("source") ?? "all";
});

// ---------------------------------------------------------------------------
// Org agents — fetch all composes for name → displayName mapping
// ---------------------------------------------------------------------------

interface AgentOption {
  name: string;
  displayName: string;
}

const internalOrgAgents$ = state<AgentOption[]>([]);

/** All agents in the current org with display names (used internally for display name mapping). */
const orgAgents$ = computed((get) => get(internalOrgAgents$));

const fetchOrgAgents$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/zero/composes/list");
  if (!resp.ok) {
    throw new Error(`Failed to fetch org agents: ${resp.statusText}`);
  }
  const data = (await resp.json()) as { composes: ComposeListItem[] };
  const agents: AgentOption[] = data.composes.map((c) => ({
    name: c.name,
    displayName:
      c.displayName ?? c.name.charAt(0).toUpperCase() + c.name.slice(1),
  }));
  set(internalOrgAgents$, agents);
});

// ---------------------------------------------------------------------------
// List — cursor pagination with URL-synced limit/cursor/filters
// ---------------------------------------------------------------------------

/** Agent name from onboarding (cached so pagination factory can read it). */
const internalAgentName$ = state<string | null>(null);

export const initZeroActivityAgentName$ = command(async ({ get, set }) => {
  const status = await get(zeroOnboardingStatus$);
  set(internalAgentName$, status.defaultAgentName);
});

/** Initialize activity page: load agent name, org agents, and seed cursor history. */
export const initZeroActivity$ = command(async ({ set }) => {
  await set(initZeroActivityAgentName$);
  await set(fetchOrgAgents$);
  set(seedZeroActivityCursorHistory$);
});

export const {
  limit$: zeroActivityLimit$,
  data$: zeroActivityData$,
  refresh$: refreshZeroActivity$,
  seedCursorHistory$: seedZeroActivityCursorHistory$,
  hasPrev$: zeroActivityHasPrev$,
  currentPage$: zeroActivityCurrentPage$,
  goToNextPage$: goToNextZeroActivityPage$,
  goToPrevPage$: goToPrevZeroActivityPage$,
  goForwardTwoPages$: goForwardTwoZeroActivityPages$,
  goBackTwoPages$: goBackTwoZeroActivityPages$,
  setRowsPerPage$: setZeroActivityRowsPerPage$,
  resetPaginationState$: resetZeroActivityPagination$,
} = createCursorPagination({
  buildFetchParams: (limit, cursor, get) => {
    const params = new URLSearchParams({
      limit: String(limit),
    });

    // Filter by specific agent when selected, otherwise fetch all
    const agentFilter = get(zeroActivityAgentFilter$);
    if (agentFilter !== "all") {
      params.set("name", agentFilter);
    }

    if (cursor) {
      params.set("cursor", cursor);
    }
    const statusFilter = get(zeroActivityStatusFilter$);
    if (statusFilter !== "all") {
      params.set("status", statusFilter);
    }
    const sourceFilter = get(zeroActivitySourceFilter$);
    if (sourceFilter !== "all") {
      params.set("triggerSource", sourceFilter);
    }
    return params;
  },
  preserveUrlParams: (get) => {
    const result: Record<string, string> = {};
    const agent = get(zeroActivityAgentFilter$);
    if (agent !== "all") {
      result.agent = agent;
    }
    const status = get(zeroActivityStatusFilter$);
    if (status !== "all") {
      result.status = status;
    }
    const source = get(zeroActivitySourceFilter$);
    if (source !== "all") {
      result.source = source;
    }
    return result;
  },
});

/** Available status values from the server (only statuses that exist in the data). */
export const zeroActivityAvailableStatuses$ = computed(async (get) => {
  const response = await get(zeroActivityData$);
  return response.filters.statuses;
});

/** Available source values from the server (only sources that exist in the data). */
export const zeroActivityAvailableSources$ = computed(async (get) => {
  const response = await get(zeroActivityData$);
  return response.filters.sources;
});

/** Available agent names from the server (only agents that have activity). */
export const zeroActivityAvailableAgents$ = computed(async (get) => {
  const response = await get(zeroActivityData$);
  const orgAgents = get(orgAgents$);
  // Map agent names to display names using org agents data
  return response.filters.agents.map((name) => {
    const agent = orgAgents.find((a) => a.name === name);
    return {
      name,
      displayName:
        agent?.displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
    };
  });
});

/** All filter keys and their corresponding signals. */
const FILTER_SIGNALS = {
  agent: zeroActivityAgentFilter$,
  status: zeroActivityStatusFilter$,
  source: zeroActivitySourceFilter$,
} as const;

type FilterKey = keyof typeof FILTER_SIGNALS;

/** Update a filter — resets pagination and writes to URL. */
export const setZeroActivityFilter$ = command(
  ({ get, set }, key: FilterKey, value: string) => {
    set(resetZeroActivityPagination$);
    const params = new URLSearchParams();

    // Preserve other filters
    for (const [k, signal] of Object.entries(FILTER_SIGNALS)) {
      if (k === key) {
        continue;
      }
      const current = get(signal);
      if (current !== "all") {
        params.set(k, current);
      }
    }

    if (value !== "all") {
      params.set(key, value);
    }

    set(updateSearchParams$, params);
  },
);

// ---------------------------------------------------------------------------
// Detail state — driven by URL sub-route
// ---------------------------------------------------------------------------

const internalPollingAbort$ = state<AbortController | null>(null);
const lastSyncedLogId$ = state<string | null>(null);

/** Currently selected log ID (readable). */
export const zeroActivitySelectedLogId$ = computed((get) =>
  get(lastSyncedLogId$),
);

// ---------------------------------------------------------------------------
// Detail step search — component-local filter for the detail view
// ---------------------------------------------------------------------------

const internalStepSearch$ = state("");

/** Current step search filter for the activity detail view. */
export const zeroActivityStepSearch$ = computed((get) =>
  get(internalStepSearch$),
);

/** Update the step search filter. */
export const setZeroActivityStepSearch$ = command(({ set }, value: string) => {
  set(internalStepSearch$, value);
});

/**
 * Set selected log ID directly — triggers detail fetch + event polling.
 */
export const setZeroActivitySelectedLogId$ = command(
  ({ get, set }, logId: string | null) => {
    // Abort any running polling before changing log
    const prev = get(internalPollingAbort$);
    if (prev) {
      prev.abort();
    }
    set(internalPollingAbort$, null);
    set(pagedEvents$, []);
    set(lastSyncedLogId$, logId);

    if (logId) {
      const controller = new AbortController();
      set(internalPollingAbort$, controller);
      detach(
        set(setupZeroActivityEventPolling$, controller.signal),
        Reason.Daemon,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Log detail
// ---------------------------------------------------------------------------

const detailReloadTick$ = state(0);

export const zeroActivityDetail$ = computed(async (get) => {
  get(detailReloadTick$);
  const logId = get(lastSyncedLogId$);
  if (!logId) {
    return null;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn(`/api/zero/logs/${logId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch log detail: ${response.statusText}`);
  }
  return (await response.json()) as LogDetail;
});

// ---------------------------------------------------------------------------
// Event polling (reuses the same pattern as log-detail-signals.ts)
// ---------------------------------------------------------------------------

function isTerminalStatus(status: LogStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

interface PageResult {
  events: AgentEvent[];
  hasMore: boolean;
}

function createEventPageComputed(
  runId: string,
  since?: string,
): Computed<Promise<PageResult>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({
      limit: String(EVENTS_PAGE_LIMIT),
      order: "asc",
    });
    if (since) {
      params.set("since", String(new Date(since).getTime()));
    }
    const response = await fetchFn(
      `/api/zero/runs/${runId}/telemetry/agent?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch agent events: ${response.statusText}`);
    }
    const data = (await response.json()) as AgentEventsResponse;
    return { events: data.events, hasMore: data.hasMore };
  });
}

const pagedEvents$ = state<Computed<Promise<PageResult>>[]>([]);

export const zeroActivityEvents$ = computed(async (get) => {
  const pages = get(pagedEvents$);
  if (pages.length === 0) {
    return [] as AgentEvent[];
  }
  const results = await Promise.all(pages.map((p) => get(p)));
  return results.flatMap((r) => r.events);
});

const pollInterval$ = state(3000);

const pollNewEvents$ = command(async ({ get, set }, runId: string) => {
  const pages = get(pagedEvents$);
  if (pages.length === 0) {
    return;
  }

  const lastPage = await get(pages[pages.length - 1]);
  if (lastPage.events.length === 0) {
    return;
  }

  const lastEvent = lastPage.events[lastPage.events.length - 1];
  const newPage = createEventPageComputed(runId, lastEvent.createdAt);
  const newPageResult = await get(newPage);

  if (newPageResult.events.length > 0) {
    set(pagedEvents$, (prev) => [...prev, newPage]);
  }
});

const setupZeroActivityEventPolling$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const logId = get(lastSyncedLogId$);
    if (!logId) {
      return;
    }

    // Phase 1: Eager initial load
    const firstPage = createEventPageComputed(logId);
    set(pagedEvents$, [firstPage]);

    let keepLoading = true;
    while (keepLoading && !signal.aborted) {
      const pages = get(pagedEvents$);
      const lastPage = await get(pages[pages.length - 1]);
      signal.throwIfAborted();
      if (lastPage.hasMore && lastPage.events.length > 0) {
        const lastEvent = lastPage.events[lastPage.events.length - 1];
        const nextPage = createEventPageComputed(logId, lastEvent.createdAt);
        set(pagedEvents$, (prev) => [...prev, nextPage]);
      } else {
        keepLoading = false;
      }
    }

    // Phase 2: Check if already terminal
    try {
      const detail = await get(zeroActivityDetail$);
      signal.throwIfAborted();
      if (detail && isTerminalStatus(detail.status)) {
        return;
      }
    } catch (error) {
      throwIfAbort(error);
    }

    // Phase 3: Polling loop
    let errorCount = 0;
    while (!signal.aborted) {
      const baseInterval = get(pollInterval$);
      const interval = Math.min(
        baseInterval * 2 ** errorCount,
        MAX_POLL_INTERVAL,
      );

      await delay(interval, { signal });
      signal.throwIfAborted();

      try {
        set(detailReloadTick$, (x) => x + 1);
        const currentDetail = await get(zeroActivityDetail$);
        signal.throwIfAborted();
        if (currentDetail && isTerminalStatus(currentDetail.status)) {
          return;
        }

        await set(pollNewEvents$, logId);
        signal.throwIfAborted();
        errorCount = 0;
      } catch (error) {
        throwIfAbort(error);
        errorCount++;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers for display conversion
// ---------------------------------------------------------------------------

export function formatLogTime(createdAt: string): string {
  const date = new Date(createdAt);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${month}/${day} ${String(h12).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

export function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
): string | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSec = Math.round(seconds % 60);
  return `${minutes}m ${remainingSec}s`;
}
