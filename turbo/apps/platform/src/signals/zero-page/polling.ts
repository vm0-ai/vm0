import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent } from "./log-types.ts";

import {
  zeroRunAgentEventsContract,
  logsByIdContract,
  zeroQueuePositionContract,
  zeroRunsCancelContract,
} from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";

const AGENT_EVENTS_PAGE_LIMIT = 30;

function isTerminalStatus(status: string | null): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

export interface PagedRunEvents {
  events: AgentEvent[];
  hasMore: boolean;
}

async function fetchEvents(
  client: ZeroClientFactory,
  runId: string,
  since?: number,
  signal?: AbortSignal,
) {
  const query: { limit: number; order: "asc"; since?: number } = {
    limit: AGENT_EVENTS_PAGE_LIMIT,
    order: "asc",
  };
  if (since !== undefined) {
    query.since = since;
  }
  const result = await accept(
    client(zeroRunAgentEventsContract).getAgentEvents({
      params: { id: runId },
      query,
      fetchOptions: {
        signal,
      },
    }),
    [200],
  );
  return { events: result.body.events, hasMore: result.body.hasMore };
}

function createEventPageComputed(
  runId: string,
  since?: number,
): Computed<Promise<PagedRunEvents>> {
  return computed(async (get) => {
    const client = get(zeroClient$);
    return await fetchEvents(client, runId, since);
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
async function findLastEventSequence(
  pages: readonly Computed<Promise<PagedRunEvents>>[],
  get: (c: Computed<Promise<PagedRunEvents>>) => Promise<PagedRunEvents>,
): Promise<number | undefined> {
  for (let i = pages.length - 1; i >= 0; i--) {
    const page = await get(pages[i]);
    const lastEvent = page.events[page.events.length - 1];
    if (lastEvent) {
      return lastEvent.sequenceNumber;
    }
  }
  return undefined;
}

function createRunPagedEvents(runId: string) {
  const firstPage = createEventPageComputed(runId);
  const pagedEventsList$ = state([firstPage]);

  const finished$ = computed(async (get) => {
    const pagedEventsList = get(pagedEventsList$);
    const lastPage = await get(pagedEventsList[pagedEventsList.length - 1]);
    return !lastPage.hasMore;
  });

  const reloadAndCheckFinished$ = command(
    async ({ set, get }, signal: AbortSignal) => {
      const finished = await get(finished$);
      signal.throwIfAborted();

      if (finished) {
        return true;
      }

      const pagedEventsList = get(pagedEventsList$);
      const since = await findLastEventSequence(pagedEventsList, get);
      signal.throwIfAborted();

      const nextPage$ = createEventPageComputed(runId, since);
      set(pagedEventsList$, (x) => {
        return [...x, nextPage$];
      });
      return false;
    },
  );

  return {
    checkFinished$: reloadAndCheckFinished$,
    pagedEventsList$,
  };
}

export function createRunLoop(runId: string) {
  const {
    detail$: runDetail$,
    reload$: reloadRunStatus$,
    finished$,
  } = createRunDetail(runId);

  const { queuePosition$, reload$: reloadQueuePosition$ } =
    createQueuePosition(runId);
  const {
    pagedEventsList$: initialRunPagedEvents$,
    checkFinished$: initialCheckFinished$,
  } = createRunPagedEvents(runId);

  const internalLoopedPagedEvents$ = state<Computed<Promise<PagedRunEvents>>[]>(
    [],
  );

  const pagedEventsList$ = computed(async (get) => {
    const initial = await get(initialRunPagedEvents$);
    const looped = get(internalLoopedPagedEvents$);
    return [...initial, ...looped];
  });

  const checkFinished$ = command(async ({ set, get }, signal: AbortSignal) => {
    if (!(await set(initialCheckFinished$, signal))) {
      return false;
    }

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

    const initialPagedEvents = await get(initialRunPagedEvents$);
    signal.throwIfAborted();

    const loopedPagedEvents = get(internalLoopedPagedEvents$);
    // Walk back across both lists (looped first, then initial) so an empty
    // tail page doesn't reset `since` to undefined and refetch from the top.
    const allPages = [...initialPagedEvents, ...loopedPagedEvents];
    const since = await findLastEventSequence(allPages, get);
    signal.throwIfAborted();

    const nextPage$ = createEventPageComputed(runId, since);
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
    pagedEventsList$,
    checkFinished$,
    cancel$,
    detail$: runDetail$,
    queuePosition$,
    finished$,
  };
}
