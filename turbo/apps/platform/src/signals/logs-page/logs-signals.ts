import { state, computed, command, type Computed } from "ccstate";
import type { LogsListResponse, LogDetail } from "./types.ts";
import { fetch$ } from "../fetch.ts";

// Internal state: Array of computed promises, each representing a batch of log IDs
const internalLogs$ = state<Computed<Promise<LogsListResponse>>[]>([]);

// Exported computed: Read-only access to logs
export const logs$ = computed((get) => get(internalLogs$));

// State for log detail cache (id -> computed detail)
const logDetailCache$ = state<Map<string, Computed<Promise<LogDetail>>>>(
  new Map(),
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

// Computed: Get next_cursor from last log response
export const currentCursor$ = computed(async (get) => {
  const logs = get(internalLogs$);

  if (logs.length === 0) {
    return null;
  }

  const lastLogComputed = logs[logs.length - 1];
  if (!lastLogComputed) {
    return null;
  }

  const response = await get(lastLogComputed);
  return response.pagination.next_cursor;
});

// Computed: Check if more data available
export const hasMore$ = computed(async (get) => {
  const logs = get(internalLogs$);

  if (logs.length === 0) {
    return false;
  }

  const lastLogComputed = logs[logs.length - 1];
  if (!lastLogComputed) {
    return false;
  }

  const response = await get(lastLogComputed);
  return response.pagination.has_more;
});

// Command: Initialize logs with first batch (clears and loads)
export const initLogs$ = command(({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  // Clear internal logs and detail cache
  set(internalLogs$, []);
  set(logDetailCache$, new Map());

  // Load first batch (no cursor for first batch)
  const firstBatch$ = computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({ limit: "20" });

    const response = await fetchFn(`/api/platform/logs?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.statusText}`);
    }

    return (await response.json()) as LogsListResponse;
  });

  set(internalLogs$, [firstBatch$]);
});

// Command: Load next batch of data
export const loadMore$ = command(async ({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  const cursor = await get(currentCursor$);
  signal.throwIfAborted();

  // Load next batch with cursor
  const nextBatch$ = computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetchFn(`/api/platform/logs?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.statusText}`);
    }

    return (await response.json()) as LogsListResponse;
  });

  set(internalLogs$, (prev) => [...prev, nextBatch$]);
});
