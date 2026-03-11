import { command, computed, state, type Computed } from "ccstate";
import type {
  LogEntry,
  LogsListResponse,
  LogDetail,
  AgentEvent,
  AgentEventsResponse,
  LogStatus,
} from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort, detach, Reason } from "../utils.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { delay } from "signal-timers";
const PAGE_LIMIT = 20;
const EVENTS_PAGE_LIMIT = 30;
const MAX_POLL_INTERVAL = 30_000;

// ---------------------------------------------------------------------------
// List state
// ---------------------------------------------------------------------------

const internalSearch$ = state("");
const internalLogs$ = state<LogEntry[]>([]);
const internalHasMore$ = state(false);
const internalNextCursor$ = state<string | null>(null);
const internalLoading$ = state(false);

export const zeroActivitySearch$ = computed((get) => get(internalSearch$));
export const zeroActivityLogs$ = computed((get) => get(internalLogs$));
export const zeroActivityHasMore$ = computed((get) => get(internalHasMore$));
export const zeroActivityLoading$ = computed((get) => get(internalLoading$));

export const setZeroActivitySearch$ = command(
  async ({ set }, search: string) => {
    set(internalSearch$, search);
    set(internalNextCursor$, null);
    await set(fetchZeroActivityLogs$);
  },
);

// ---------------------------------------------------------------------------
// Fetch logs for the default agent
// ---------------------------------------------------------------------------

export const fetchZeroActivityLogs$ = command(async ({ get, set }) => {
  const status = await get(zeroOnboardingStatus$);
  const agentName = status.defaultAgentName;
  if (!agentName) {
    set(internalLogs$, []);
    set(internalHasMore$, false);
    return;
  }

  set(internalLoading$, true);

  try {
    const fetchFn = get(fetch$);
    const search = get(internalSearch$);
    const cursor = get(internalNextCursor$);

    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      name: agentName,
    });
    if (search.trim()) {
      params.set("search", search.trim());
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetchFn(`/api/platform/logs?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.statusText}`);
    }

    const data = (await response.json()) as LogsListResponse;
    if (cursor) {
      // Append for "load more"
      set(internalLogs$, (prev) => [...prev, ...data.data]);
    } else {
      set(internalLogs$, data.data);
    }
    set(internalHasMore$, data.pagination.hasMore);
    set(internalNextCursor$, data.pagination.nextCursor);
  } finally {
    set(internalLoading$, false);
  }
});

export const loadMoreZeroActivityLogs$ = command(async ({ get, set }) => {
  const hasMore = get(internalHasMore$);
  if (!hasMore) {
    return;
  }
  await set(fetchZeroActivityLogs$);
});

// ---------------------------------------------------------------------------
// Detail state
// ---------------------------------------------------------------------------

const internalSelectedLogId$ = state<string | null>(null);
const internalPollingAbort$ = state<AbortController | null>(null);

export const zeroActivitySelectedLogId$ = computed((get) =>
  get(internalSelectedLogId$),
);

export const setZeroActivitySelectedLogId$ = command(
  ({ get, set }, logId: string | null) => {
    // Abort any running polling before changing log
    const prev = get(internalPollingAbort$);
    if (prev) {
      prev.abort();
    }
    set(internalPollingAbort$, null);
    set(pagedEvents$, []);
    set(internalSelectedLogId$, logId);

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
  const logId = get(internalSelectedLogId$);
  if (!logId) {
    return null;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn(`/api/platform/logs/${logId}`);
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
      `/api/agent/runs/${runId}/telemetry/agent?${params.toString()}`,
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
    const logId = get(internalSelectedLogId$);
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

export function logStatusToActivityStatus(
  status: LogStatus,
): "success" | "error" | "warning" | "running" {
  switch (status) {
    case "completed": {
      return "success";
    }
    case "failed": {
      return "error";
    }
    case "timeout":
    case "cancelled": {
      return "warning";
    }
    case "queued":
    case "pending":
    case "running": {
      return "running";
    }
  }
}

export function formatLogTime(createdAt: string): string {
  const date = new Date(createdAt);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${String(h12).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${ampm}`;
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
