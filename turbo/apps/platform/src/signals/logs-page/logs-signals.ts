import { state, computed, command } from "ccstate";
import type { LogsListResponse } from "./types.ts";
import { fetch$ } from "../fetch.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";

const DEFAULT_LIMIT = 10;
const VALID_LIMITS = [10, 20, 50, 100] as const;

// ---------------------------------------------------------------------------
// URL-derived computeds
// ---------------------------------------------------------------------------

export const limit$ = computed((get) => {
  const raw = get(searchParams$).get("limit");
  if (!raw) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  return VALID_LIMITS.includes(parsed as (typeof VALID_LIMITS)[number])
    ? parsed
    : DEFAULT_LIMIT;
});

export const cursor$ = computed((get) => {
  return get(searchParams$).get("cursor") ?? null;
});

export const search$ = computed((get) => {
  return get(searchParams$).get("search") ?? "";
});

// Aliases for view backward compatibility
export const rowsPerPageValue$ = computed((get) => get(limit$));
export const searchQueryValue$ = computed((get) => get(search$));

// ---------------------------------------------------------------------------
// Data fetching — single async computed
// ---------------------------------------------------------------------------

export const currentPageLogs$ = computed(async (get) => {
  const fetchFn = get(fetch$);
  const limit = get(limit$);
  const cursor = get(cursor$);
  const search = get(search$);

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

// ---------------------------------------------------------------------------
// Cursor history — the only runtime state
// ---------------------------------------------------------------------------

const cursorHistory$ = state<(string | null)[]>([null]);

export const seedCursorHistory$ = command(({ get, set }) => {
  const cursor = get(cursor$);
  if (cursor) {
    set(cursorHistory$, [null, cursor]);
  } else {
    set(cursorHistory$, [null]);
  }
});

// ---------------------------------------------------------------------------
// Derived pagination computeds
// ---------------------------------------------------------------------------

export const hasPrevPage$ = computed((get) => get(cursor$) !== null);

export const currentPageNumber$ = computed((get) => {
  const cursor = get(cursor$);
  const history = get(cursorHistory$);
  const idx = history.indexOf(cursor);
  return idx === -1 ? 1 : idx + 1;
});

// ---------------------------------------------------------------------------
// Internal command: write URL params
// ---------------------------------------------------------------------------

interface UrlParamOverrides {
  cursor?: string | null;
  limit?: number;
  search?: string;
}

const writeUrlParams$ = command(
  ({ get, set }, overrides: UrlParamOverrides) => {
    const params = new URLSearchParams();
    const limit = overrides.limit !== undefined ? overrides.limit : get(limit$);
    const cursor =
      overrides.cursor !== undefined ? overrides.cursor : get(cursor$);
    const search =
      overrides.search !== undefined ? overrides.search : get(search$);

    if (limit !== DEFAULT_LIMIT) {
      params.set("limit", String(limit));
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (search) {
      params.set("search", search);
    }

    set(updateSearchParams$, params);
  },
);

// ---------------------------------------------------------------------------
// Navigation commands — URL writers only
// ---------------------------------------------------------------------------

export const goToNextPage$ = command(async ({ get, set }) => {
  const response = await get(currentPageLogs$);
  if (!response.pagination.hasMore) {
    return;
  }

  const nextCursor = response.pagination.nextCursor;
  const cursor = get(cursor$);
  const history = get(cursorHistory$);
  const currentIdx = Math.max(0, history.indexOf(cursor));

  set(cursorHistory$, (prev) => {
    const next = [...prev];
    if (next.length <= currentIdx + 1) {
      next.push(nextCursor);
    } else {
      next[currentIdx + 1] = nextCursor;
    }
    return next;
  });

  set(writeUrlParams$, { cursor: nextCursor });
});

export const goToPrevPage$ = command(({ get, set }) => {
  const cursor = get(cursor$);
  const history = get(cursorHistory$);
  const currentIdx = history.indexOf(cursor);
  if (currentIdx <= 0) {
    return;
  }

  const prevCursor = history[currentIdx - 1] ?? null;
  set(writeUrlParams$, { cursor: prevCursor });
});

export const goForwardTwoPages$ = command(async ({ get, set }) => {
  const response1 = await get(currentPageLogs$);
  if (!response1.pagination.hasMore) {
    return;
  }

  const cursor1 = response1.pagination.nextCursor;
  if (!cursor1) {
    return;
  }

  const currentCursor = get(cursor$);
  const history = get(cursorHistory$);
  const idx = Math.max(0, history.indexOf(currentCursor));

  set(cursorHistory$, (prev) => {
    const next = [...prev];
    if (next.length <= idx + 1) {
      next.push(cursor1);
    } else {
      next[idx + 1] = cursor1;
    }
    return next;
  });

  // Fetch intermediate page to get second cursor
  const limit = get(limit$);
  const search = get(search$);
  const params = new URLSearchParams({ limit: String(limit) });
  params.set("cursor", cursor1);
  if (search) {
    params.set("search", search);
  }
  const fetchFn = get(fetch$);
  const resp2 = await fetchFn(`/api/platform/logs?${params.toString()}`);

  if (!resp2.ok) {
    set(writeUrlParams$, { cursor: cursor1 });
    return;
  }

  const response2 = (await resp2.json()) as LogsListResponse;
  if (!response2.pagination.hasMore) {
    set(writeUrlParams$, { cursor: cursor1 });
    return;
  }

  const cursor2 = response2.pagination.nextCursor;
  set(cursorHistory$, (prev) => {
    const next = [...prev];
    if (next.length <= idx + 2) {
      next.push(cursor2);
    } else {
      next[idx + 2] = cursor2;
    }
    return next;
  });

  set(writeUrlParams$, { cursor: cursor2 });
});

export const goBackTwoPages$ = command(({ get, set }) => {
  const cursor = get(cursor$);
  const history = get(cursorHistory$);
  const currentIdx = history.indexOf(cursor);
  if (currentIdx <= 0) {
    return;
  }

  const targetIdx = Math.max(0, currentIdx - 2);
  const targetCursor = history[targetIdx] ?? null;
  set(writeUrlParams$, { cursor: targetCursor });
});

export const setRowsPerPage$ = command(({ set }, limit: number) => {
  set(cursorHistory$, [null]);
  set(writeUrlParams$, { cursor: null, limit });
});

export const setSearch$ = command(({ set }, search: string) => {
  set(cursorHistory$, [null]);
  set(writeUrlParams$, { cursor: null, search });
});
