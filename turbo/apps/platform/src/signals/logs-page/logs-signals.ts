import { state, computed, command, type Computed } from "ccstate";
import type { LogResponse } from "./types.ts";
import { navigateInReact$ } from "../route.ts";
import { fetch$ } from "../fetch.ts";

// Internal state: Array of computed promises, each representing a batch of data
const internalLogs$ = state<Computed<Promise<LogResponse>>[]>([]);

// Exported computed: Read-only access to logs
export const logs$ = computed((get) => get(internalLogs$));

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

  // Clear internal logs
  set(internalLogs$, []);

  // Load first batch (no cursor for first batch)
  const firstBatch$ = computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({ limit: "20" });

    const response = await fetchFn(`/v1/runs?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch runs: ${response.statusText}`);
    }

    return (await response.json()) as LogResponse;
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

    const response = await fetchFn(`/v1/runs?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch runs: ${response.statusText}`);
    }

    return (await response.json()) as LogResponse;
  });

  set(internalLogs$, (prev) => [...prev, nextBatch$]);
});

// Command: Navigate to run detail page
export const navigateToRunDetail$ = command(({ set }) => {
  // TODO: Add /runs/:id to RoutePath type once run detail page is implemented
  // For now, navigate to home as placeholder
  set(navigateInReact$, "/");
});
