import { state, computed, command, type Computed } from "ccstate";
import type { LogResponse, FilterType } from "./types.ts";
import { searchParams$, navigateInReact$ } from "../route.ts";
import { fetch$ } from "../fetch.ts";

// Internal state: Array of computed promises, each representing a batch of data
const internalLogs$ = state<Computed<Promise<LogResponse>>[]>([]);

// Exported command: Set logs state (for tests and commands)
export const setLogs$ = command<
  void,
  [
    | Computed<Promise<LogResponse>>[]
    | ((
        prev: Computed<Promise<LogResponse>>[],
      ) => Computed<Promise<LogResponse>>[]),
  ]
>(({ set, get }, logsOrFn) => {
  if (typeof logsOrFn === "function") {
    const prev = get(internalLogs$);
    set(internalLogs$, logsOrFn(prev));
  } else {
    set(internalLogs$, logsOrFn);
  }
});

// Exported computed: Read-only access to logs
export const logs$ = computed((get) => get(internalLogs$));

// Computed: Derive filter from URL query params
export const selectedFilter$ = computed((get) => {
  const params = get(searchParams$);
  const filter = params.get("filter");

  // Validate filter value
  const validFilters: FilterType[] = ["all", "agent", "system", "network"];
  return validFilters.includes(filter as FilterType)
    ? (filter as FilterType)
    : "all";
});

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

// Helper: Create computed that fetches a batch of runs
export function createLogsFetch(
  cursor: string | null,
): Computed<Promise<LogResponse>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);

    // Build URL with query params
    const url = new URL("/v1/runs", window.location.origin);
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    url.searchParams.set("limit", "20");

    // Fetch from API
    const response = await fetchFn(url.toString());

    if (!response.ok) {
      throw new Error(`Failed to fetch runs: ${response.statusText}`);
    }

    return (await response.json()) as LogResponse;
  });
}

// Command: Load next batch of data
export const loadMore$ = command(async ({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  const cursor = await get(currentCursor$);
  const newComputed = createLogsFetch(cursor);

  set(setLogs$, (prev) => [...prev, newComputed]);
});

// Command: Change filter (navigates to new URL)
export const changeFilter$ = command(({ set }, filter: FilterType) => {
  set(navigateInReact$, "/logs", {
    searchParams: new URLSearchParams({ filter }),
  });
  // Note: Navigation triggers setupLogsPage$ which resets state
});

// Command: Navigate to run detail page
export const navigateToRunDetail$ = command(({ set }) => {
  // TODO: Add /runs/:id to RoutePath type once run detail page is implemented
  // For now, navigate to home as placeholder
  set(navigateInReact$, "/");
});
