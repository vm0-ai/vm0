import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent } from "./log-types.ts";

import {
  zeroRunAgentEventsContract,
  zeroRunsCancelContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";

const INITIAL_AGENT_EVENTS_PAGE_LIMIT = 100;
const POLLED_AGENT_EVENTS_PAGE_LIMIT = 30;

function isTerminalStatus(status: string | null): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

interface PagedRunEvents {
  events: AgentEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface EventPageRequest {
  since?: number;
  cursor?: string;
}

async function fetchEvents(
  client: ZeroClientFactory,
  runId: string,
  options: {
    limit: number;
    since?: number;
    cursor?: string;
    signal?: AbortSignal;
  },
): Promise<PagedRunEvents> {
  const query: {
    limit: number;
    order: "asc";
    since?: number;
    cursor?: string;
  } = {
    limit: options.limit,
    order: "asc",
  };
  if (options.cursor !== undefined) {
    query.cursor = options.cursor;
  } else if (options.since !== undefined) {
    query.since = options.since;
  }
  const result = await accept(
    client(zeroRunAgentEventsContract).getAgentEvents({
      params: { id: runId },
      query,
      fetchOptions: {
        signal: options.signal,
      },
    }),
    [200],
  );
  return {
    events: result.body.events,
    hasMore: result.body.hasMore,
    nextCursor: result.body.nextCursor ?? null,
  };
}

function createEventPageComputed(
  runId: string,
  limit: number,
  request: EventPageRequest = {},
): Computed<Promise<PagedRunEvents>> {
  return computed(async (get) => {
    const client = get(zeroClient$);
    return await fetchEvents(client, runId, { limit, ...request });
  });
}

function createRunDetail(runId: string) {
  const internalReloadRunStatus$ = state(0);
  const runStatusResp$ = computed(async (get) => {
    get(internalReloadRunStatus$);
    const client = get(zeroClient$)(logsByIdContract);
    const result = await accept(
      client.getById({
        params: { id: runId },
      }),
      [200],
    );
    return result;
  });

  const runDetail$ = computed(async (get) => {
    const resp = await get(runStatusResp$);
    return resp.body;
  });

  return {
    detail$: runDetail$,
    finished$: computed(async (get) => {
      const status = (await get(runDetail$)).status;
      return isTerminalStatus(status);
    }),
    reload$: command(({ set }) => {
      return set(internalReloadRunStatus$, (x) => {
        return x + 1;
      });
    }),
  };
}

function createQueuePosition(runId: string) {
  const internalReload$ = state(0);

  return {
    queuePosition$: computed(async (get) => {
      get(internalReload$);
      const createClient = get(zeroClient$);
      const client = createClient(zeroQueuePositionContract);
      const result = await accept(
        client.getPosition({ query: { runId } }),
        [200],
        { toast: false },
      );
      return result.body.position;
    }),
    reload$: command(({ set }) => {
      return set(internalReload$, (x) => {
        return x + 1;
      });
    }),
  };
}

/**
 * Walk backwards through already-fetched pages to find the most recent event's
 * `sequenceNumber`. Needed because a page can legitimately return zero events
 * (e.g. during a long-running tool like `Bash sleep`), and using that empty
 * page's (absent) last event as `since` would cause the next page to refetch
 * from the beginning of the run — yielding duplicate events in the accumulated
 * stream.
 *
 * Uses `sequenceNumber` (integer) instead of `createdAt` because Axiom stores
 * `_time` at nanosecond precision but JS Date is millisecond precision, so a
 * timestamp cursor would truncate sub-millisecond digits and cause the server
 * to return the boundary event again on the next page.
 */
function findLastEventSequence(
  pages: readonly PagedRunEvents[],
): number | undefined {
  for (let i = pages.length - 1; i >= 0; i--) {
    const page = pages[i];
    const lastEvent = page.events[page.events.length - 1];
    if (lastEvent) {
      return lastEvent.sequenceNumber;
    }
  }
  return undefined;
}

function nextEventPageRequest(
  pages: readonly PagedRunEvents[],
): EventPageRequest | null {
  const lastPage = pages[pages.length - 1];
  // Prefer the server-provided cursor over reconstructing a sequence cursor.
  if (lastPage?.hasMore && lastPage.nextCursor) {
    const repeatedCursor = pages.slice(0, -1).some((page) => {
      return page.nextCursor === lastPage.nextCursor;
    });
    if (repeatedCursor) {
      return null;
    }
    return { cursor: lastPage.nextCursor };
  }

  const since = findLastEventSequence(pages);
  if (lastPage?.hasMore && since === undefined) {
    return null;
  }
  return since === undefined ? {} : { since };
}

function createRunPagedEvents(runId: string) {
  const initialPagedEventsList$ = computed(async (get) => {
    const pages = [
      createEventPageComputed(runId, INITIAL_AGENT_EVENTS_PAGE_LIMIT),
    ];

    while (true) {
      const lastPage = await get(pages[pages.length - 1]);
      if (!lastPage.hasMore) {
        return pages;
      }

      const resolvedPages = await Promise.all(
        pages.map((page$) => {
          return get(page$);
        }),
      );
      const request = nextEventPageRequest(resolvedPages);
      if (!request) {
        return pages;
      }
      pages.push(
        createEventPageComputed(
          runId,
          INITIAL_AGENT_EVENTS_PAGE_LIMIT,
          request,
        ),
      );
    }
  });

  return { pagedEventsList$: initialPagedEventsList$ };
}

export function createRunLoop(runId: string) {
  const {
    detail$: runDetail$,
    reload$: reloadRunStatus$,
    finished$,
  } = createRunDetail(runId);

  const { queuePosition$, reload$: reloadQueuePosition$ } =
    createQueuePosition(runId);
  const { pagedEventsList$: initialRunPagedEvents$ } =
    createRunPagedEvents(runId);

  const internalLoopedPagedEvents$ = state<Computed<Promise<PagedRunEvents>>[]>(
    [],
  );

  const pagedEventsList$ = computed(async (get) => {
    const initial = await get(initialRunPagedEvents$);
    const looped = get(internalLoopedPagedEvents$);
    return [...initial, ...looped];
  });

  const checkFinished$ = command(async ({ set, get }, signal: AbortSignal) => {
    const initialPagedEvents = await get(initialRunPagedEvents$);
    signal.throwIfAborted();

    set(reloadRunStatus$);
    let status = (await get(runDetail$)).status;
    signal.throwIfAborted();

    if (status === "pending") {
      set(reloadQueuePosition$);
      status = (await get(runDetail$)).status;
      signal.throwIfAborted();
    }

    if (status === "pending") {
      return false;
    }

    const loopedPagedEvents = get(internalLoopedPagedEvents$);
    // Walk back across both lists (looped first, then initial) so an empty
    // tail page doesn't reset `since` to undefined and refetch from the top.
    const allPages = [...initialPagedEvents, ...loopedPagedEvents];
    const resolvedPages = await Promise.all(
      allPages.map((page$) => {
        return get(page$);
      }),
    );
    signal.throwIfAborted();
    const request = nextEventPageRequest(resolvedPages);
    if (!request) {
      set(reloadRunStatus$);
      const finished = await get(finished$);
      signal.throwIfAborted();
      return finished;
    }

    const nextPage$ = createEventPageComputed(
      runId,
      POLLED_AGENT_EVENTS_PAGE_LIMIT,
      request,
    );
    set(internalLoopedPagedEvents$, (prev) => {
      return [...prev, nextPage$];
    });

    set(reloadRunStatus$);

    const lastPage = await get(nextPage$);
    signal.throwIfAborted();

    const finished = await get(finished$);
    signal.throwIfAborted();

    return finished && !lastPage.hasMore;
  });

  const cancel$ = command(async ({ get }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroRunsCancelContract);
    await accept(
      client.cancel({
        params: { id: runId },
        fetchOptions: { signal },
      }),
      [200],
    );
  });

  return {
    runId,
    pagedEventsList$,
    checkFinished$,
    cancel$,
    detail$: runDetail$,
    queuePosition$,
    finished$,
  };
}
