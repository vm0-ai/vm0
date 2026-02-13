import { state, computed, command } from "ccstate";
import type { LogsListResponse } from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { agentName$ } from "./agent-detail.ts";

const DEFAULT_LIMIT = 10;
const VALID_LIMITS = [10, 20, 50, 100] as const;

// ---------------------------------------------------------------------------
// URL-derived computeds
// ---------------------------------------------------------------------------

export const agentLogsLimit$ = computed((get) => {
  const raw = get(searchParams$).get("limit");
  if (!raw) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  return VALID_LIMITS.includes(parsed as (typeof VALID_LIMITS)[number])
    ? parsed
    : DEFAULT_LIMIT;
});

const agentLogsCursor$ = computed((get) => {
  return get(searchParams$).get("cursor") ?? null;
});

// ---------------------------------------------------------------------------
// Data fetching — single async computed
// ---------------------------------------------------------------------------

export const currentAgentLogs$ = computed(async (get) => {
  const fetchFn = get(fetch$);
  const limit = get(agentLogsLimit$);
  const cursor = get(agentLogsCursor$);
  const agentName = get(agentName$);

  if (!agentName) {
    return {
      data: [],
      pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
    } satisfies LogsListResponse;
  }

  const params = new URLSearchParams({
    limit: String(limit),
    agent: agentName,
  });
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await fetchFn(`/api/platform/logs?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch agent logs: ${response.statusText}`);
  }
  return (await response.json()) as LogsListResponse;
});

// ---------------------------------------------------------------------------
// Cursor history — the only runtime state
// ---------------------------------------------------------------------------

const cursorHistory$ = state<(string | null)[]>([null]);

export const seedAgentLogsCursorHistory$ = command(({ get, set }) => {
  const cursor = get(agentLogsCursor$);
  if (cursor) {
    set(cursorHistory$, [null, cursor]);
  } else {
    set(cursorHistory$, [null]);
  }
});

// ---------------------------------------------------------------------------
// Derived pagination computeds
// ---------------------------------------------------------------------------

export const agentLogsHasPrev$ = computed(
  (get) => get(agentLogsCursor$) !== null,
);

export const agentLogsCurrentPage$ = computed((get) => {
  const cursor = get(agentLogsCursor$);
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
}

const writeUrlParams$ = command(
  ({ get, set }, overrides: UrlParamOverrides) => {
    const params = new URLSearchParams();
    const limit =
      overrides.limit !== undefined ? overrides.limit : get(agentLogsLimit$);
    const cursor =
      overrides.cursor !== undefined ? overrides.cursor : get(agentLogsCursor$);

    if (limit !== DEFAULT_LIMIT) {
      params.set("limit", String(limit));
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    set(updateSearchParams$, params);
  },
);

// ---------------------------------------------------------------------------
// Navigation commands — URL writers only
// ---------------------------------------------------------------------------

export const goToNextAgentLogsPage$ = command(async ({ get, set }) => {
  const response = await get(currentAgentLogs$);
  if (!response.pagination.hasMore) {
    return;
  }

  const nextCursor = response.pagination.nextCursor;
  const cursor = get(agentLogsCursor$);
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

export const goToPrevAgentLogsPage$ = command(({ get, set }) => {
  const cursor = get(agentLogsCursor$);
  const history = get(cursorHistory$);
  const currentIdx = history.indexOf(cursor);
  if (currentIdx <= 0) {
    return;
  }

  const prevCursor = history[currentIdx - 1] ?? null;
  set(writeUrlParams$, { cursor: prevCursor });
});

export const goForwardTwoAgentLogsPages$ = command(async ({ get, set }) => {
  const response1 = await get(currentAgentLogs$);
  if (!response1.pagination.hasMore) {
    return;
  }

  const cursor1 = response1.pagination.nextCursor;
  if (!cursor1) {
    return;
  }

  const currentCursor = get(agentLogsCursor$);
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
  const limit = get(agentLogsLimit$);
  const agentName = get(agentName$);
  const params = new URLSearchParams({ limit: String(limit) });
  params.set("cursor", cursor1);
  if (agentName) {
    params.set("agent", agentName);
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

export const goBackTwoAgentLogsPages$ = command(({ get, set }) => {
  const cursor = get(agentLogsCursor$);
  const history = get(cursorHistory$);
  const currentIdx = history.indexOf(cursor);
  if (currentIdx <= 0) {
    return;
  }

  const targetIdx = Math.max(0, currentIdx - 2);
  const targetCursor = history[targetIdx] ?? null;
  set(writeUrlParams$, { cursor: targetCursor });
});

export const setAgentLogsRowsPerPage$ = command(({ set }, limit: number) => {
  set(cursorHistory$, [null]);
  set(writeUrlParams$, { cursor: null, limit });
});
