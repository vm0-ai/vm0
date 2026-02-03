import { state, computed, command, type Computed } from "ccstate";
import type {
  LogsListResponse,
  LogDetail,
  AgentEventsResponse,
  ArtifactDownloadResponse,
  AgentEvent,
} from "./types.ts";
import { fetch$ } from "../fetch.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";

const DEFAULT_LIMIT = 10;
const VALID_LIMITS = [10, 20, 50, 100] as const;

// Pagination state
const rowsPerPage$ = state<number>(DEFAULT_LIMIT);
const cursorHistory$ = state<(string | null)[]>([null]); // Track cursors for each page
const currentPageIndex$ = state<number>(0); // 0-based index

// Search state
const searchQuery$ = state<string>("");

/**
 * Helper to sync current pagination state to URL searchParams
 */
const syncToSearchParams$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  const limit = get(rowsPerPage$);
  const history = get(cursorHistory$);
  const pageIndex = get(currentPageIndex$);
  const search = get(searchQuery$);
  const cursor = history[pageIndex] ?? null;

  // Update limit (only if not default)
  if (limit !== DEFAULT_LIMIT) {
    params.set("limit", String(limit));
  } else {
    params.delete("limit");
  }

  // Update cursor (only if not on first page)
  if (cursor) {
    params.set("cursor", cursor);
  } else {
    params.delete("cursor");
  }

  // Update search (only if not empty)
  if (search) {
    params.set("search", search);
  } else {
    params.delete("search");
  }

  set(updateSearchParams$, params);
});

// Exported computed for rows per page
export const rowsPerPageValue$ = computed((get) => get(rowsPerPage$));

// Exported computed for search query
export const searchQueryValue$ = computed((get) => get(searchQuery$));

// Internal state: Current page data
const internalCurrentPage$ = state<Computed<Promise<LogsListResponse>> | null>(
  null,
);

// Exported computed: Read-only access to current page logs
export const currentPageLogs$ = computed((get) => get(internalCurrentPage$));

// State for log detail cache (id -> computed detail)
const logDetailCache$ = state<Map<string, Computed<Promise<LogDetail>>>>(
  new Map(),
);

// Agent events pagination constants
const AGENT_EVENTS_INITIAL_LIMIT = 30;
const AGENT_EVENTS_LOAD_MORE_LIMIT = 30;

// State for agent events cache (id -> computed events)
const agentEventsCache$ = state<
  Map<string, Computed<Promise<AgentEventsResponse>>>
>(new Map());

// Accumulated events state for infinite scroll
const internalAgentEventsAccumulated$ = state<AgentEvent[]>([]);
const internalAgentEventsHasMore$ = state<boolean>(false);
const internalAgentEventsIsLoadingMore$ = state<boolean>(false);

// Exported computed for accumulated events
export const agentEventsAccumulated$ = computed((get) =>
  get(internalAgentEventsAccumulated$),
);
export const agentEventsHasMore$ = computed((get) =>
  get(internalAgentEventsHasMore$),
);
export const agentEventsIsLoadingMore$ = computed((get) =>
  get(internalAgentEventsIsLoadingMore$),
);

/**
 * Command to initialize accumulated events from initial load.
 * This command is idempotent - it only sets state if not already initialized.
 */
export const initAccumulatedEvents$ = command(
  ({ get, set }, params: { events: AgentEvent[]; hasMore: boolean }) => {
    // Skip if already initialized to prevent race conditions during render
    const current = get(internalAgentEventsAccumulated$);
    if (current.length > 0) {
      return;
    }
    set(internalAgentEventsAccumulated$, params.events);
    set(internalAgentEventsHasMore$, params.hasMore);
  },
);

/**
 * Create a computed for fetching log detail by ID.
 */
function createLogDetailComputed(logId: string): Computed<Promise<LogDetail>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn(`/api/platform/logs/${logId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch log detail: ${response.statusText}`);
    }
    return (await response.json()) as LogDetail;
  });
}

/**
 * Command to get or create a log detail computed.
 * Returns the cached computed if it exists, otherwise creates and caches a new one.
 */
export const getOrCreateLogDetail$ = command(
  ({ get, set }, logId: string): Computed<Promise<LogDetail>> => {
    const cache = get(logDetailCache$);
    const cached = cache.get(logId);
    if (cached) {
      return cached;
    }

    const detail$ = createLogDetailComputed(logId);
    set(logDetailCache$, (prev) => {
      const newCache = new Map(prev);
      newCache.set(logId, detail$);
      return newCache;
    });
    return detail$;
  },
);

/**
 * Create a computed for fetching initial agent events by run ID.
 */
function createAgentEventsComputed(
  runId: string,
): Computed<Promise<AgentEventsResponse>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({
      limit: String(AGENT_EVENTS_INITIAL_LIMIT),
      order: "asc",
    });
    const response = await fetchFn(
      `/api/agent/runs/${runId}/telemetry/agent?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch agent events: ${response.statusText}`);
    }
    return (await response.json()) as AgentEventsResponse;
  });
}

/**
 * Command to get or create an agent events computed.
 * Returns the cached computed if it exists, otherwise creates and caches a new one.
 */
export const getOrCreateAgentEvents$ = command(
  ({ get, set }, runId: string): Computed<Promise<AgentEventsResponse>> => {
    const cache = get(agentEventsCache$);
    const cached = cache.get(runId);
    if (cached) {
      return cached;
    }

    const events$ = createAgentEventsComputed(runId);
    set(agentEventsCache$, (prev) => {
      const newCache = new Map(prev);
      newCache.set(runId, events$);
      return newCache;
    });
    return events$;
  },
);

/**
 * Command to load more agent events for a run.
 * Updates accumulated state with the additional events.
 */
export const loadMoreAgentEvents$ = command(
  async (
    { get, set },
    params: { runId: string; since: string },
  ): Promise<void> => {
    const { runId, since } = params;

    // Set loading state
    set(internalAgentEventsIsLoadingMore$, true);

    try {
      const fetchFn = get(fetch$);
      const sinceMs = new Date(since).getTime();
      const urlParams = new URLSearchParams({
        limit: String(AGENT_EVENTS_LOAD_MORE_LIMIT),
        order: "asc",
        since: String(sinceMs),
      });
      const response = await fetchFn(
        `/api/agent/runs/${runId}/telemetry/agent?${urlParams.toString()}`,
      );
      if (!response.ok) {
        throw new Error(
          `Failed to fetch more agent events: ${response.statusText}`,
        );
      }
      const data = (await response.json()) as AgentEventsResponse;

      // Append new events to accumulated state
      set(internalAgentEventsAccumulated$, (prev) => [...prev, ...data.events]);
      set(internalAgentEventsHasMore$, data.hasMore);
    } finally {
      set(internalAgentEventsIsLoadingMore$, false);
    }
  },
);

// Note: hasNextPage is determined from currentPageLogs$ data in the component

// Computed: Check if has previous page
export const hasPrevPage$ = computed((get) => {
  const pageIndex = get(currentPageIndex$);
  return pageIndex > 0;
});

// Computed: Current page number (1-based for display)
export const currentPageNumber$ = computed((get) => get(currentPageIndex$) + 1);

/**
 * Helper to create a page computed
 */
function createPageComputed(
  cursor: string | null,
  limit: number,
  search: string,
): Computed<Promise<LogsListResponse>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (search) {
      params.set("search", search);
    }

    const response = await fetchFn(`/api/platform/logs?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.statusText}`);
    }

    return (await response.json()) as LogsListResponse;
  });
}

// Command: Initialize logs with first page
export const initLogs$ = command(({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  // Clear caches
  set(logDetailCache$, new Map());
  set(agentEventsCache$, new Map());

  // Reset accumulated events state
  set(internalAgentEventsAccumulated$, []);
  set(internalAgentEventsHasMore$, false);
  set(internalAgentEventsIsLoadingMore$, false);

  // Read initial values from URL searchParams
  const params = get(searchParams$);
  const limitParam = params.get("limit");
  const cursorParam = params.get("cursor");
  const searchParam = params.get("search");

  // Parse and validate limit
  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (VALID_LIMITS.includes(parsed as (typeof VALID_LIMITS)[number])) {
      limit = parsed;
    }
  }

  // Set initial state from URL params
  set(rowsPerPage$, limit);
  set(searchQuery$, searchParam ?? "");

  // Initialize cursor history with the cursor from URL (if any)
  // If cursor is provided, we're on page 2+ but we don't know page 1's cursor
  // So we start fresh - cursor history will be rebuilt on navigation
  if (cursorParam) {
    set(cursorHistory$, [null, cursorParam]);
    set(currentPageIndex$, 1);
  } else {
    set(cursorHistory$, [null]);
    set(currentPageIndex$, 0);
  }

  // Load page with cursor from URL
  const search = searchParam ?? "";
  const page$ = createPageComputed(cursorParam, limit, search);
  set(internalCurrentPage$, page$);
});

// Command: Go to next page
export const goToNextPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();

    const currentPage = get(internalCurrentPage$);
    if (!currentPage) {
      return;
    }

    const response = await get(currentPage);
    signal.throwIfAborted();

    if (!response.pagination.hasMore) {
      return;
    }

    const nextCursor = response.pagination.nextCursor;
    const currentIndex = get(currentPageIndex$);
    const limit = get(rowsPerPage$);
    const search = get(searchQuery$);

    // Store the next cursor in history
    set(cursorHistory$, (prev) => {
      const newHistory = [...prev];
      // Ensure we have space for the next page's cursor
      if (newHistory.length <= currentIndex + 1) {
        newHistory.push(nextCursor);
      } else {
        newHistory[currentIndex + 1] = nextCursor;
      }
      return newHistory;
    });

    // Move to next page
    set(currentPageIndex$, currentIndex + 1);

    // Load next page
    const nextPage$ = createPageComputed(nextCursor, limit, search);
    set(internalCurrentPage$, nextPage$);

    // Sync to URL
    set(syncToSearchParams$);
  },
);

// Command: Go to previous page
export const goToPrevPage$ = command(({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  const currentIndex = get(currentPageIndex$);
  if (currentIndex <= 0) {
    return;
  }

  const prevIndex = currentIndex - 1;
  const history = get(cursorHistory$);
  const prevCursor = history[prevIndex] ?? null;
  const limit = get(rowsPerPage$);
  const search = get(searchQuery$);

  // Move to previous page
  set(currentPageIndex$, prevIndex);

  // Load previous page
  const prevPage$ = createPageComputed(prevCursor, limit, search);
  set(internalCurrentPage$, prevPage$);

  // Sync to URL
  set(syncToSearchParams$);
});

// Command: Go forward two pages
export const goForwardTwoPages$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();

    const limit = get(rowsPerPage$);
    const search = get(searchQuery$);

    // First page forward
    const currentPage = get(internalCurrentPage$);
    if (!currentPage) {
      return;
    }

    let response = await get(currentPage);
    signal.throwIfAborted();

    if (!response.pagination.hasMore) {
      return;
    }

    let nextCursor = response.pagination.nextCursor;
    let currentIndex = get(currentPageIndex$);

    // Store cursor and move to next page
    set(cursorHistory$, (prev) => {
      const newHistory = [...prev];
      if (newHistory.length <= currentIndex + 1) {
        newHistory.push(nextCursor);
      } else {
        newHistory[currentIndex + 1] = nextCursor;
      }
      return newHistory;
    });
    set(currentPageIndex$, currentIndex + 1);

    // Load the intermediate page to get its cursor
    const intermediatePage$ = createPageComputed(nextCursor, limit, search);
    response = await get(intermediatePage$);
    signal.throwIfAborted();

    if (!response.pagination.hasMore) {
      // Only one more page available, stay on it
      set(internalCurrentPage$, intermediatePage$);
      // Sync to URL
      set(syncToSearchParams$);
      return;
    }

    // Second page forward
    nextCursor = response.pagination.nextCursor;
    currentIndex = get(currentPageIndex$);

    set(cursorHistory$, (prev) => {
      const newHistory = [...prev];
      if (newHistory.length <= currentIndex + 1) {
        newHistory.push(nextCursor);
      } else {
        newHistory[currentIndex + 1] = nextCursor;
      }
      return newHistory;
    });
    set(currentPageIndex$, currentIndex + 1);

    const finalPage$ = createPageComputed(nextCursor, limit, search);
    set(internalCurrentPage$, finalPage$);

    // Sync to URL
    set(syncToSearchParams$);
  },
);

// Command: Go back two pages
export const goBackTwoPages$ = command(({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  const currentIndex = get(currentPageIndex$);
  if (currentIndex <= 0) {
    return;
  }

  // Go back 2 pages, but not below 0
  const targetIndex = Math.max(0, currentIndex - 2);
  const history = get(cursorHistory$);
  const targetCursor = history[targetIndex] ?? null;
  const limit = get(rowsPerPage$);
  const search = get(searchQuery$);

  set(currentPageIndex$, targetIndex);

  const targetPage$ = createPageComputed(targetCursor, limit, search);
  set(internalCurrentPage$, targetPage$);

  // Sync to URL
  set(syncToSearchParams$);
});

// Command: Set rows per page and reload
export const setRowsPerPage$ = command(
  ({ get, set }, params: { limit: number; signal: AbortSignal }) => {
    const { limit, signal } = params;
    signal.throwIfAborted();

    set(rowsPerPage$, limit);

    // Reset to first page
    set(cursorHistory$, [null]);
    set(currentPageIndex$, 0);

    // Reload with new limit
    const search = get(searchQuery$);
    const firstPage$ = createPageComputed(null, limit, search);
    set(internalCurrentPage$, firstPage$);

    // Sync to URL
    set(syncToSearchParams$);
  },
);

// Command: Set search query and reload
export const setSearch$ = command(
  ({ get, set }, params: { search: string; signal: AbortSignal }) => {
    const { search, signal } = params;
    signal.throwIfAborted();

    set(searchQuery$, search);

    // Reset to first page
    set(cursorHistory$, [null]);
    set(currentPageIndex$, 0);

    // Reload with new search
    const limit = get(rowsPerPage$);
    const firstPage$ = createPageComputed(null, limit, search);
    set(internalCurrentPage$, firstPage$);

    // Sync to URL
    set(syncToSearchParams$);
  },
);

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

      // Trigger download by opening the presigned URL
      window.open(data.url, "_blank");
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
