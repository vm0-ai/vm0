import { state, computed, command, type Computed } from "ccstate";
import type { LogsListResponse } from "./types.ts";
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
