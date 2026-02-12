import { computed, command, state, type Computed } from "ccstate";
import type {
  LogDetail,
  AgentEvent,
  AgentEventsResponse,
  ArtifactDownloadResponse,
  LogStatus,
} from "./types.ts";
import { delay } from "signal-timers";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { currentLogId$ } from "./log-detail-state.ts";

const AGENT_EVENTS_PAGE_LIMIT = 30;
const MAX_INTERVAL = 30_000;

const pollInterval$ = state(3000);

/** Command to override the poll interval (ms). Used by tests. */
export const setPollInterval$ = command(({ set }, ms: number) => {
  set(pollInterval$, ms);
});

function isTerminalStatus(status: LogStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

// ---------------------------------------------------------------------------
// Log detail — re-fetchable via detailReloadTick$
// ---------------------------------------------------------------------------

const detailReloadTick$ = state(0);

/**
 * Async computed that fetches log detail for the current logId.
 * Re-evaluates when currentLogId$ or detailReloadTick$ changes.
 */
export const runDetail$ = computed(async (get) => {
  get(detailReloadTick$);
  const logId = get(currentLogId$);
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
// Incremental event pages — computed-per-page pattern
// ---------------------------------------------------------------------------

interface PageResult {
  events: AgentEvent[];
  hasMore: boolean;
}

/**
 * Factory: creates one immutable computed per page fetch.
 * Once resolved, ccstate caches the result forever (no changing dependencies).
 */
function createEventPageComputed(
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

/**
 * Mutable state: list of page computeds for the current logId.
 * Each entry is an immutable computed that fetches one page of events.
 */
const pagedEvents$ = state<Computed<Promise<PageResult>>[]>([]);

/**
 * Derived computed: flatten all page computeds into a single event array.
 * React reads this via useLastLoadable to avoid flicker between polls.
 */
export const allEvents$ = computed(async (get) => {
  const pages = get(pagedEvents$);
  if (pages.length === 0) {
    return [] as AgentEvent[];
  }
  const results = await Promise.all(pages.map((p) => get(p)));
  return results.flatMap((r) => r.events);
});

// ---------------------------------------------------------------------------
// Polling commands
// ---------------------------------------------------------------------------

/**
 * Command: check for new events since the last page and append if found.
 * Each invocation makes at most 1 API call.
 */
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

/**
 * Command: set up incremental polling for the current log.
 *
 * Phase 1: Eager initial load — fetch all existing event pages.
 * Phase 2: Check if the run is already in a terminal state.
 * Phase 3: Start a polling loop that checks for new events and
 *          re-fetches log detail to detect terminal status.
 *
 * The signal (from route lifecycle) aborts polling on navigation away.
 */
export const setupEventPolling$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const logId = get(currentLogId$);
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
    // Detail fetch may fail (e.g. 404) — the UI handles that via
    // useLastLoadable(runDetail$), so we just skip the terminal check
    // and fall through to the polling loop.
    try {
      const detail = await get(runDetail$);
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
      const interval = Math.min(baseInterval * 2 ** errorCount, MAX_INTERVAL);

      await delay(interval, { signal });
      signal.throwIfAborted();

      try {
        // Re-fetch detail to check terminal status
        set(detailReloadTick$, (x) => x + 1);
        const currentDetail = await get(runDetail$);
        signal.throwIfAborted();
        if (currentDetail && isTerminalStatus(currentDetail.status)) {
          return; // stop polling
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
// Artifact download (unchanged)
// ---------------------------------------------------------------------------

// State for tracking current artifact download promise
const internalArtifactDownloadPromise$ = state<Promise<void> | null>(null);

/**
 * Exported computed for artifact download status
 */
export const artifactDownloadPromise$ = computed((get) =>
  get(internalArtifactDownloadPromise$),
);

/**
 * Command to download artifact.
 * Fetches the presigned URL and triggers a download.
 */
export const downloadArtifact$ = command(
  ({ get, set }, params: { name: string; version?: string }): Promise<void> => {
    const downloadPromise = (async () => {
      const fetchFn = get(fetch$);
      const searchParams = new URLSearchParams({ name: params.name });
      if (params.version) {
        searchParams.set("version", params.version);
      }

      const response = await fetchFn(
        `/api/platform/artifacts/download?${searchParams.toString()}`,
      );

      if (!response.ok) {
        const errorData = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(
          errorData.error?.message ?? `Failed to get download URL`,
        );
      }

      const data = (await response.json()) as ArtifactDownloadResponse;

      // Validate URL before attempting to open
      if (!data.url) {
        throw new Error("Download URL not provided by server");
      }

      // Trigger download by opening the presigned URL
      const opened = window.open(data.url, "_blank");

      // Check if popup was blocked
      if (!opened || opened.closed || typeof opened.closed === "undefined") {
        throw new Error(
          "Download blocked by browser. Please allow popups for this site.",
        );
      }
    })();

    set(internalArtifactDownloadPromise$, downloadPromise);

    // Clear promise after completion (success or failure)
    downloadPromise
      .finally(() => {
        set(internalArtifactDownloadPromise$, null);
      })
      .catch(() => {
        // Error is already handled in the main promise chain
      });

    return downloadPromise;
  },
);
