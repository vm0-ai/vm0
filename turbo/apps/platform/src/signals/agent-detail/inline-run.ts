import { command, computed, state, type Computed } from "ccstate";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogDetail,
  LogStatus,
} from "../logs-page/types.ts";
import { delay } from "signal-timers";
import { fetch$ } from "../fetch.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { search } from "../location.ts";

const L = logger("InlineRun");

const AGENT_EVENTS_PAGE_LIMIT = 30;
const MAX_INTERVAL = 30_000;
const BASE_POLL_INTERVAL = 3000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalActiveRunId$ = state<string | null>(null);
export const activeRunId$ = computed((get) => get(internalActiveRunId$));

const internalInlineRunEvents$ = state<Computed<Promise<PageResult>>[]>([]);

const internalInlineRunStatus$ = state<LogStatus | null>(null);
export const inlineRunStatus$ = computed((get) =>
  get(internalInlineRunStatus$),
);

/** Whether a run is being created (API in flight, no runId yet). */
const internalPendingRun$ = state(false);

/** True while restoring inline run from URL — cleared after first status check. */
const internalInitFromUrl$ = state(false);
export const isInlineRunInitializing$ = computed((get) =>
  get(internalInitFromUrl$),
);

/** Whether the inline run panel should be visible. */
export const isRunPanelVisible$ = computed(
  (get) => get(internalPendingRun$) || get(internalActiveRunId$) !== null,
);

/** Clear old run state and enter pending mode (called when user triggers a new run). */
export const prepareNewRun$ = command(({ get, set }) => {
  // Abort old polling
  const controller = get(pollingAbortController$);
  if (controller) {
    controller.abort();
    set(pollingAbortController$, null);
  }

  // Clear old state
  set(internalActiveRunId$, null);
  set(internalInlineRunEvents$, []);
  set(internalInlineRunStatus$, null);

  // Enter pending mode
  set(internalPendingRun$, true);
});

/** Cancel pending run (called when API fails). Hides the panel. */
export const cancelPendingRun$ = command(({ set }) => {
  set(internalPendingRun$, false);
});

/** Abort controller for the current polling session, stored as signal state */
const pollingAbortController$ = state<AbortController | null>(null);

// ---------------------------------------------------------------------------
// Page result & factory
// ---------------------------------------------------------------------------

interface PageResult {
  events: AgentEvent[];
  hasMore: boolean;
}

function createInlineEventPageComputed(
  runId: string,
  since?: string,
): Computed<Promise<PageResult>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({
      limit: String(AGENT_EVENTS_PAGE_LIMIT),
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

// ---------------------------------------------------------------------------
// Derived: flatten all pages into a single event array
// ---------------------------------------------------------------------------

export const allInlineRunEvents$ = computed(async (get) => {
  const pages = get(internalInlineRunEvents$);
  if (pages.length === 0) {
    return [] as AgentEvent[];
  }
  const results = await Promise.all(pages.map((p) => get(p)));
  const all = results.flatMap((r) => r.events);

  // Deduplicate by sequenceNumber (fresh page re-fetches may overlap)
  const seen = new Set<number>();
  return all.filter((e) => {
    if (seen.has(e.sequenceNumber)) {
      return false;
    }
    seen.add(e.sequenceNumber);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Terminal status helper
// ---------------------------------------------------------------------------

function isTerminalStatus(status: LogStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

/** Run button state: idle (clickable), starting (API in flight), running (run active). */
type RunButtonState = "idle" | "starting" | "running";

export const runButtonState$ = computed<RunButtonState>((get) => {
  if (get(internalPendingRun$)) {
    return "starting";
  }
  const runId = get(internalActiveRunId$);
  if (runId === null) {
    return "idle";
  }
  const status = get(internalInlineRunStatus$);
  if (status === null) {
    return "running";
  }
  return isTerminalStatus(status) ? "idle" : "running";
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const startInlineRun$ = command(({ get, set }, runId: string) => {
  set(internalPendingRun$, false);
  set(internalActiveRunId$, runId);
  set(internalInlineRunEvents$, []);
  set(internalInlineRunStatus$, null);

  // Update URL with runId
  const params = new URLSearchParams(search());
  params.set("runId", runId);
  set(updateSearchParams$, params);

  // Abort any existing polling
  const prev = get(pollingAbortController$);
  if (prev) {
    prev.abort();
  }
  const controller = new AbortController();
  set(pollingAbortController$, controller);

  // Start polling (fire-and-forget, errors handled internally)
  set(setupInlineRunPolling$, controller.signal).catch((error: unknown) => {
    throwIfAbort(error);
    L.error("Inline run polling error:", error);
  });
});

export const initInlineRunFromUrl$ = command(({ get, set }) => {
  const params = get(searchParams$);
  const runId = params.get("runId");
  if (runId) {
    set(internalInitFromUrl$, true);
    set(startInlineRun$, runId);
  }
});

export const closeInlineRun$ = command(({ get, set }) => {
  // Abort polling
  const controller = get(pollingAbortController$);
  if (controller) {
    controller.abort();
    set(pollingAbortController$, null);
  }

  set(internalActiveRunId$, null);
  set(internalInlineRunEvents$, []);
  set(internalInlineRunStatus$, null);

  // Remove runId from URL
  const params = new URLSearchParams(search());
  params.delete("runId");
  set(updateSearchParams$, params);
});

// ---------------------------------------------------------------------------
// Polling — three-phase pattern (mirrors log-detail-signals.ts)
// ---------------------------------------------------------------------------

const pollNewInlineEvents$ = command(async ({ get, set }, runId: string) => {
  const pages = get(internalInlineRunEvents$);
  if (pages.length === 0) {
    return;
  }

  const lastPage = await get(pages[pages.length - 1]);
  if (lastPage.events.length === 0) {
    // Cached page was empty — create a fresh page to re-fetch from start
    const freshPage = createInlineEventPageComputed(runId);
    set(internalInlineRunEvents$, [freshPage]);
    return;
  }

  const lastEvent = lastPage.events[lastPage.events.length - 1];
  const newPage = createInlineEventPageComputed(runId, lastEvent.createdAt);
  const newPageResult = await get(newPage);

  if (newPageResult.events.length > 0) {
    set(internalInlineRunEvents$, (prev) => [...prev, newPage]);
  }
});

const setupInlineRunPolling$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(internalActiveRunId$);
    if (!runId) {
      return;
    }

    // Phase 1: Eager initial load — fetch all existing event pages
    const firstPage = createInlineEventPageComputed(runId);
    set(internalInlineRunEvents$, [firstPage]);

    let keepLoading = true;
    while (keepLoading && !signal.aborted) {
      const pages = get(internalInlineRunEvents$);
      const lastPage = await get(pages[pages.length - 1]);
      signal.throwIfAborted();
      if (lastPage.hasMore && lastPage.events.length > 0) {
        const lastEvent = lastPage.events[lastPage.events.length - 1];
        const nextPage = createInlineEventPageComputed(
          runId,
          lastEvent.createdAt,
        );
        set(internalInlineRunEvents$, (prev) => [...prev, nextPage]);
      } else {
        keepLoading = false;
      }
    }

    // Phase 2: Check if already terminal
    try {
      const fetchFn = get(fetch$);
      const response = await fetchFn(`/api/platform/logs/${runId}`);
      signal.throwIfAborted();
      if (response.ok) {
        const detail = (await response.json()) as LogDetail;
        set(internalInlineRunStatus$, detail.status);
        if (isTerminalStatus(detail.status)) {
          // Fetch any events that arrived after the initial load
          await set(pollNewInlineEvents$, runId);
          signal.throwIfAborted();
          return;
        }
      }
    } catch (error) {
      throwIfAbort(error);
    } finally {
      set(internalInitFromUrl$, false);
    }

    // Phase 3: Polling loop
    let errorCount = 0;

    while (!signal.aborted) {
      const interval = Math.min(
        BASE_POLL_INTERVAL * 2 ** errorCount,
        MAX_INTERVAL,
      );

      await delay(interval, { signal });
      signal.throwIfAborted();

      try {
        // Re-fetch run status
        const fetchFn = get(fetch$);
        const response = await fetchFn(`/api/platform/logs/${runId}`);
        signal.throwIfAborted();

        if (response.ok) {
          const detail = (await response.json()) as LogDetail;
          set(internalInlineRunStatus$, detail.status);
          if (isTerminalStatus(detail.status)) {
            // Fetch any remaining events before stopping
            await set(pollNewInlineEvents$, runId);
            signal.throwIfAborted();
            return;
          }
        }

        await set(pollNewInlineEvents$, runId);
        signal.throwIfAborted();
        errorCount = 0;
      } catch (error) {
        throwIfAbort(error);
        errorCount++;
      }
    }
  },
);
