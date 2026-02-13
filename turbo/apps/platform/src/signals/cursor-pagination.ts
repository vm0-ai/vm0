/**
 * Factory for cursor-based pagination signals.
 *
 * Encapsulates the shared pagination machinery (URL-driven limit/cursor,
 * cursor history, navigation commands) so that each paginated list only
 * needs to provide a URL builder for the data fetch.
 */
import { state, computed, command, type Computed, type State } from "ccstate";
import type { LogsListResponse } from "./logs-page/types.ts";
import { fetch$ } from "./fetch.ts";
import { searchParams$, updateSearchParams$ } from "./route.ts";

const DEFAULT_LIMIT = 10;
const VALID_LIMITS = [10, 20, 50, 100] as const;

type GetAccessor = <T>(atom: Computed<T>) => T;

interface CursorPaginationConfig {
  /**
   * Build the URLSearchParams for the data fetch.
   * Receives limit, cursor, and a `get` accessor to read other signals.
   * Must include limit; cursor is already handled by the caller.
   */
  buildFetchParams: (
    limit: number,
    cursor: string | null,
    get: GetAccessor,
  ) => URLSearchParams | null;

  /**
   * Extra URL search params to preserve when writing pagination params.
   * Return entries to merge into the URLSearchParams being written.
   */
  preserveUrlParams?: (get: GetAccessor) => Record<string, string>;
}

interface UrlParamOverrides {
  cursor?: string | null;
  limit?: number;
}

interface PaginationDeps {
  config: CursorPaginationConfig;
  limit$: Computed<number>;
  cursor$: Computed<string | null>;
  data$: Computed<Promise<LogsListResponse>>;
  cursorHistory$: State<(string | null)[]>;
  writeUrlParams$: ReturnType<typeof command<void, [UrlParamOverrides]>>;
}

function createNavigationCommands(deps: PaginationDeps) {
  const { config, limit$, cursor$, data$, cursorHistory$, writeUrlParams$ } =
    deps;

  const goToNextPage$ = command(async ({ get, set }) => {
    const response = await get(data$);
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

  const goToPrevPage$ = command(({ get, set }) => {
    const cursor = get(cursor$);
    const history = get(cursorHistory$);
    const currentIdx = history.indexOf(cursor);
    if (currentIdx <= 0) {
      return;
    }

    const prevCursor = history[currentIdx - 1] ?? null;
    set(writeUrlParams$, { cursor: prevCursor });
  });

  const goForwardTwoPages$ = command(async ({ get, set }) => {
    const response1 = await get(data$);
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
    const intermediateParams = config.buildFetchParams(
      get(limit$),
      cursor1,
      get,
    );
    if (!intermediateParams) {
      set(writeUrlParams$, { cursor: cursor1 });
      return;
    }

    const fetchFn = get(fetch$);
    const resp2 = await fetchFn(
      `/api/platform/logs?${intermediateParams.toString()}`,
    );

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

  const goBackTwoPages$ = command(({ get, set }) => {
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

  return {
    goToNextPage$,
    goToPrevPage$,
    goForwardTwoPages$,
    goBackTwoPages$,
  };
}

export function createCursorPagination(config: CursorPaginationConfig) {
  const limit$ = computed((get) => {
    const raw = get(searchParams$).get("limit");
    if (!raw) {
      return DEFAULT_LIMIT;
    }
    const parsed = Number.parseInt(raw, 10);
    return VALID_LIMITS.includes(parsed as (typeof VALID_LIMITS)[number])
      ? parsed
      : DEFAULT_LIMIT;
  });

  const cursor$ = computed((get) => {
    return get(searchParams$).get("cursor") ?? null;
  });

  const data$ = computed(async (get) => {
    const fetchFn = get(fetch$);
    const limit = get(limit$);
    const cursor = get(cursor$);

    const params = config.buildFetchParams(limit, cursor, get);
    if (!params) {
      return {
        data: [],
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
      } satisfies LogsListResponse;
    }

    const response = await fetchFn(`/api/platform/logs?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.statusText}`);
    }
    return (await response.json()) as LogsListResponse;
  });

  const cursorHistory$ = state<(string | null)[]>([null]);

  const seedCursorHistory$ = command(({ get, set }) => {
    const cursor = get(cursor$);
    if (cursor) {
      set(cursorHistory$, [null, cursor]);
    } else {
      set(cursorHistory$, [null]);
    }
  });

  const hasPrev$ = computed((get) => get(cursor$) !== null);

  const currentPage$ = computed((get) => {
    const cursor = get(cursor$);
    const history = get(cursorHistory$);
    const idx = history.indexOf(cursor);
    return idx === -1 ? 1 : idx + 1;
  });

  const writeUrlParams$ = command(
    ({ get, set }, overrides: UrlParamOverrides) => {
      const params = new URLSearchParams();
      const limit =
        overrides.limit !== undefined ? overrides.limit : get(limit$);
      const cursor =
        overrides.cursor !== undefined ? overrides.cursor : get(cursor$);

      if (limit !== DEFAULT_LIMIT) {
        params.set("limit", String(limit));
      }
      if (cursor) {
        params.set("cursor", cursor);
      }

      if (config.preserveUrlParams) {
        const extra = config.preserveUrlParams(get);
        for (const [key, value] of Object.entries(extra)) {
          if (value) {
            params.set(key, value);
          }
        }
      }

      set(updateSearchParams$, params);
    },
  );

  const nav = createNavigationCommands({
    config,
    limit$,
    cursor$,
    data$,
    cursorHistory$,
    writeUrlParams$,
  });

  const setRowsPerPage$ = command(({ set }, limit: number) => {
    set(cursorHistory$, [null]);
    set(writeUrlParams$, { cursor: null, limit });
  });

  const resetPaginationState$ = command(({ set }) => {
    set(cursorHistory$, [null]);
  });

  return {
    limit$,
    cursor$,
    data$,
    seedCursorHistory$,
    hasPrev$,
    currentPage$,
    ...nav,
    setRowsPerPage$,
    resetPaginationState$,
  };
}
