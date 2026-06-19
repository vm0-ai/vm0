import { state, computed, command } from "ccstate";
import { zeroRunNetworkLogsContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import type { InitClientArgs, InitClientReturn } from "@ts-rest/core";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";

const PAGE_LIMIT = 500;
const MAX_PAGES = 20;

type NetworkLogsClient = InitClientReturn<
  typeof zeroRunNetworkLogsContract,
  InitClientArgs
>;

/**
 * Fetch a single page of network logs.
 */
async function fetchPage(
  client: NetworkLogsClient,
  runId: string,
  signal?: AbortSignal,
  cursor?: string,
): Promise<{
  logs: NetworkLogEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const result = await accept(
    client.getNetworkLogs({
      params: { id: runId },
      query: {
        limit: PAGE_LIMIT,
        order: "asc",
        ...(cursor !== undefined && { cursor }),
      },
      fetchOptions: signal ? { signal } : undefined,
    }),
    [200],
  );
  const nextCursor = result.body.nextCursor ?? null;
  return {
    logs: result.body.networkLogs,
    hasMore: result.body.hasMore && nextCursor !== null,
    nextCursor,
  };
}

/**
 * Paginate through all network log pages for a given run (used by download).
 */
export async function fetchAllNetworkLogs(
  client: NetworkLogsClient,
  runId: string,
  signal: AbortSignal,
): Promise<NetworkLogEntry[]> {
  const all: NetworkLogEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    signal.throwIfAborted();
    const { logs, hasMore, nextCursor } = await fetchPage(
      client,
      runId,
      signal,
      cursor,
    );
    all.push(...logs);

    if (!hasMore || logs.length === 0 || nextCursor === cursor) {
      break;
    }

    cursor = nextCursor ?? undefined;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Incremental page-loading signals (for UI display)
// ---------------------------------------------------------------------------

/**
 * First page — auto-fetched via computed when runId changes.
 */
const firstPage$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }
  const client = get(zeroClient$)(zeroRunNetworkLogsContract);
  return await fetchPage(client, runId);
});

interface PaginationState {
  runId: string | null;
  logs: NetworkLogEntry[];
  hasMore: boolean;
  cursor: string | undefined;
  pageCount: number;
  loading: boolean;
}

/** Extra-pages pagination state, managed by loadNetworkLogsNextPage$. */
const pagination$ = state<PaginationState>({
  runId: null,
  logs: [],
  hasMore: false,
  cursor: undefined,
  pageCount: 0,
  loading: false,
});

/**
 * Combined signal for the UI. Merges auto-loaded first page with
 * any extra pages loaded via loadNetworkLogsNextPage$.
 */
export const zeroActivityNetworkLogs$ = computed(async (get) => {
  const first = await get(firstPage$);
  if (!first) {
    return {
      networkLogs: [] as NetworkLogEntry[],
      hasMore: false,
      loading: false,
    };
  }

  const runId = get(currentRunId$);
  const pg = get(pagination$);
  const extraRunMatch = pg.runId === runId;
  const extra = extraRunMatch ? pg.logs : [];
  const hasMore =
    extraRunMatch && pg.pageCount > 0 ? pg.hasMore : first.hasMore;
  const loading = pg.loading;

  return {
    networkLogs: [...first.logs, ...extra],
    hasMore,
    loading,
  };
});

/**
 * Load the next page. Called by "Load more" button.
 */
export const loadNetworkLogsNextPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(currentRunId$);
    if (!runId) {
      return;
    }

    let pg = get(pagination$);

    // Initialise pagination state on first "load more" for this run
    if (pg.runId !== runId) {
      const first = await get(firstPage$);
      signal.throwIfAborted();
      if (!first || !first.hasMore || first.logs.length === 0) {
        return;
      }
      pg = {
        runId,
        logs: [],
        hasMore: first.hasMore,
        cursor: first.nextCursor ?? undefined,
        pageCount: 1,
        loading: false,
      };
      set(pagination$, pg);
    }

    if (!pg.hasMore || pg.loading || pg.pageCount >= MAX_PAGES) {
      return;
    }

    set(pagination$, { ...pg, loading: true });

    const clearLoading = () => {
      set(pagination$, (current) => {
        return current.loading ? { ...current, loading: false } : current;
      });
    };

    const client = get(zeroClient$)(zeroRunNetworkLogsContract);
    const { logs, hasMore, nextCursor } = await fetchPage(
      client,
      runId,
      signal,
      pg.cursor,
    ).finally(clearLoading);
    signal.throwIfAborted();

    set(pagination$, (current) => {
      const repeatedCursor =
        nextCursor !== null && nextCursor === current.cursor;
      return {
        ...current,
        logs: [...current.logs, ...logs],
        hasMore: hasMore && !repeatedCursor,
        cursor: nextCursor ?? current.cursor,
        pageCount: current.pageCount + 1,
        loading: false,
      };
    });
  },
);
