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
    { toast: false },
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

/** Extra logs appended via "Load more". */
const extraLogs$ = state<NetworkLogEntry[]>([]);

/** Whether the last fetched page indicated more data. */
const extraHasMore$ = state<boolean | null>(null);

/** Cursor for the next page. */
const nextSince$ = state<number | undefined>(undefined);

/** Pages loaded so far (1 = first page only). */
const pageCount$ = state(0);

/** Whether a "load more" request is in flight. */
const loadingMore$ = state(false);

/** The runId that extra state belongs to (for stale detection). */
const extraRunId$ = state<string | null>(null);

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
  const extraRunMatch = get(extraRunId$) === runId;
  const extra = extraRunMatch ? get(extraLogs$) : [];
  const hasMore =
    extraRunMatch && get(extraHasMore$) !== null
      ? get(extraHasMore$)
      : first.hasMore;
  const loading = get(loadingMore$);

  return {
    networkLogs: [...first.logs, ...extra],
    hasMore: hasMore ?? false,
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

    // Initialise extra state on first "load more" for this run
    if (get(extraRunId$) !== runId) {
      const first = await get(firstPage$);
      if (!first || !first.hasMore || first.logs.length === 0) {
        return;
      }
      set(extraRunId$, runId);
      set(extraLogs$, []);
      set(extraHasMore$, first.hasMore);
      set(pageCount$, 1);
      const lastEntry = first.logs[first.logs.length - 1];
      set(nextSince$, new Date(lastEntry.timestamp).getTime());
    }

    if (get(extraHasMore$) === false || get(loadingMore$)) {
      return;
    }

    if (get(pageCount$) >= MAX_PAGES) {
      return;
    }

    set(loadingMore$, true);

    try {
      const since = get(nextSince$);
      const client = get(zeroClient$)(zeroRunNetworkLogsContract);
      const { logs, hasMore } = await fetchPage(client, runId, since);

      set(extraLogs$, [...get(extraLogs$), ...logs]);
      set(extraHasMore$, hasMore);
      set(pageCount$, get(pageCount$) + 1);

      if (logs.length > 0) {
        const lastEntry = logs[logs.length - 1];
        set(nextSince$, new Date(lastEntry.timestamp).getTime());
      }
    } finally {
      set(loadingMore$, false);
    }
  },
);
