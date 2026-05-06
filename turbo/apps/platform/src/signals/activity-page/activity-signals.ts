import { command, computed, state } from "ccstate";
import type { AgentEvent } from "../zero-page/log-types.ts";
import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";
import type { ComposeListItem } from "@vm0/api-contracts/contracts/composes";
import { pathParams$, searchParams$, updateSearchParams$ } from "../route.ts";
import { createCursorPagination } from "../cursor-pagination.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { zeroClient$ } from "../api-client.ts";
import { createRunLoop } from "../zero-page/polling.ts";
import { delay } from "signal-timers";
import { accept } from "../../lib/accept.ts";
import {
  autoScrollActivityDetail$,
  scrollToBottomActivityDetail$,
} from "./activity-detail-scroll.ts";
import { setAblyLoop$ } from "../realtime.ts";

// ---------------------------------------------------------------------------
// Filters — URL-derived
// ---------------------------------------------------------------------------

/** Agent ID filter derived from URL `?agent=` query param. */
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
// Org agents — fetch all composes for id → displayName mapping
// ---------------------------------------------------------------------------

interface AgentOption {
  id: string;
  displayName: string;
}

const internalOrgAgents$ = state<AgentOption[]>([]);

/** All agents in the current org with display names (used internally for display name mapping). */
const orgAgents$ = computed((get) => {
  return get(internalOrgAgents$);
});

const fetchOrgAgents$ = command(async ({ get, set }, _signal: AbortSignal) => {
  const client = get(zeroClient$)(zeroComposesListContract);
  const result = await accept(client.list({ query: {} }), [200]);
  const agents: AgentOption[] = result.body.composes.map(
    (c: ComposeListItem) => {
      return {
        id: c.id,
        displayName: c.displayName ?? c.id,
      };
    },
  );
  set(internalOrgAgents$, agents);
});

// ---------------------------------------------------------------------------
// List — cursor pagination with URL-synced limit/cursor/filters
// ---------------------------------------------------------------------------

/** Agent ID from onboarding (cached so pagination factory can read it). */
const internalAgentId$ = state<string | null>(null);

export const initZeroActivityAgentId$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const status = await get(zeroOnboardingStatus$);
    set(internalAgentId$, status.defaultAgentId);
  },
);

/** Initialize activity page: load agent ID, org agents, and seed cursor history. */
export const initZeroActivity$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(initZeroActivityAgentId$, signal);
    await set(fetchOrgAgents$, signal);
    set(seedZeroActivityCursorHistory$);
  },
);

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
      params.set("agentId", agentFilter);
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

/** Available agent IDs from the server (only agents that have activity). */
export const zeroActivityAvailableAgents$ = computed(async (get) => {
  const response = await get(zeroActivityData$);
  const orgAgents = get(orgAgents$);
  // Map agent IDs to display names using org agents data
  return response.filters.agents.map((id: string) => {
    const agent = orgAgents.find((a) => {
      return a.id === id;
    });
    return {
      name: id,
      displayName: agent?.displayName ?? id,
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

export const currentRunId$ = computed((get) => {
  const params = get(pathParams$);
  if (params && typeof params === "object" && "activityRunId" in params) {
    return String(params.activityRunId);
  }
  return null;
});

// ---------------------------------------------------------------------------
// Detail step search — component-local filter for the detail view
// ---------------------------------------------------------------------------

const internalStepSearch$ = state("");

/** Current step search filter for the activity detail view. */
export const zeroActivityStepSearch$ = computed((get) => {
  return get(internalStepSearch$);
});

/** Update the step search filter. */
export const setZeroActivityStepSearch$ = command(({ set }, value: string) => {
  set(internalStepSearch$, value);
});

/**
 * Active run loop for the currently selected log.
 */
const internalActiveRunLoop$ = state<ReturnType<typeof createRunLoop> | null>(
  null,
);

/**
 * Set selected log ID directly — triggers detail fetch + event polling.
 */
export const setupActivityLogLoop$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalActiveRunLoop$, null);
    });

    const runId = get(currentRunId$);
    if (!runId) {
      return;
    }

    const run = createRunLoop(runId);
    set(internalActiveRunLoop$, run);
    // Yield one microtask tick so React can flush the run detail panel into the
    // DOM before we trigger scrollToBottomActivityDetail$. Without this yield
    // the scroll container may still reflect the previous layout and the scroll
    // would be a no-op.
    await delay(0, { signal });
    set(scrollToBottomActivityDetail$);

    const onRunChanged$ = command(async ({ set }, sig: AbortSignal) => {
      const finished = await set(run.checkFinished$, sig);
      sig.throwIfAborted();
      set(autoScrollActivityDetail$);
      return finished;
    });

    const finished = await set(onRunChanged$, signal);
    signal.throwIfAborted();
    if (finished) {
      return;
    }

    await Promise.all([
      set(setAblyLoop$, `run:changed:${runId}`, onRunChanged$, signal),
      set(setAblyLoop$, "queue:changed", onRunChanged$, signal),
    ]);
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Log detail — re-fetches when run status changes (polling drives updates)
// ---------------------------------------------------------------------------

export const zeroActivityDetail$ = computed(async (get) => {
  const run = get(internalActiveRunLoop$);
  if (!run) {
    return null;
  }

  return await get(run.detail$);
});

// ---------------------------------------------------------------------------
// Events — flattened from run loop's paged events
// ---------------------------------------------------------------------------

export const zeroActivityEvents$ = computed(async (get) => {
  const run = get(internalActiveRunLoop$);
  if (!run) {
    // Return null (not []) so useLastLoadable won't treat a stale empty array
    // as "hasData" while the real events are still loading.
    return null;
  }
  const pages = await get(run.pagedEventsList$);
  if (pages.length === 0) {
    return [] as AgentEvent[];
  }
  const results = await Promise.all(
    pages.map((p) => {
      return get(p);
    }),
  );
  return results.flatMap((r) => {
    return r.events;
  });
});

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
