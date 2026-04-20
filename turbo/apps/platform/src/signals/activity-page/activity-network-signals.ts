import { state, computed, command } from "ccstate";
import { zeroRunNetworkLogsContract, type NetworkLogEntry } from "@vm0/core";
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
  since?: number,
): Promise<{ logs: NetworkLogEntry[]; hasMore: boolean }> {
  const result = await accept(
    client.getNetworkLogs({
      params: { id: runId },
      query: {
        limit: PAGE_LIMIT,
        order: "asc",
        ...(since !== undefined && { since }),
      },
    }),
    [200],
  );
  return { logs: result.body.networkLogs, hasMore: result.body.hasMore };
}

/**
 * Paginate through all network log pages for a given run (used by download).
 */
export async function fetchAllNetworkLogs(
  client: NetworkLogsClient,
  runId: string,
): Promise<NetworkLogEntry[]> {
  const all: NetworkLogEntry[] = [];
  let since: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { logs, hasMore } = await fetchPage(client, runId, since);
    all.push(...logs);

    if (!hasMore || logs.length === 0) {
      break;
    }

    const lastEntry = logs[logs.length - 1];
    since = new Date(lastEntry.timestamp).getTime();
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
  since: number | undefined;
  pageCount: number;
  loading: boolean;
}

/** Extra-pages pagination state, managed by loadNetworkLogsNextPage$. */
const pagination$ = state<PaginationState>({
  runId: null,
  logs: [],
  hasMore: false,
  since: undefined,
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
  async ({ get, set }, _signal: AbortSignal) => {
    const runId = get(currentRunId$);
    if (!runId) {
      return;
    }

    let pg = get(pagination$);

    // Initialise pagination state on first "load more" for this run
    if (pg.runId !== runId) {
      const first = await get(firstPage$);
      if (!first || !first.hasMore || first.logs.length === 0) {
        return;
      }
      const lastEntry = first.logs[first.logs.length - 1];
      pg = {
        runId,
        logs: [],
        hasMore: first.hasMore,
        since: new Date(lastEntry.timestamp).getTime(),
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
    const { logs, hasMore } = await fetchPage(client, runId, pg.since).finally(
      clearLoading,
    );

    const lastEntry = logs.length > 0 ? logs[logs.length - 1] : undefined;
    set(pagination$, (current) => {
      return {
        ...current,
        logs: [...current.logs, ...logs],
        hasMore,
        since: lastEntry
          ? new Date(lastEntry.timestamp).getTime()
          : current.since,
        pageCount: current.pageCount + 1,
        loading: false,
      };
    });
  },
);
