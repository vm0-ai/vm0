import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent } from "./log-types.ts";

import {
  zeroRunAgentEventsContract,
  logsByIdContract,
  zeroQueuePositionContract,
  zeroRunsCancelContract,
} from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { delay } from "signal-timers";
import { logger } from "../log.ts";

const L = logger("Polling");

const AGENT_EVENTS_PAGE_LIMIT = 30;

const DEFAULT_FIBONACCI_DELAYS_MS = [
  1000, 1000, 2000, 3000, 5000, 8000, 13_000, 21_000, 34_000, 55_000, 60_000,
] as const;

const internalFibDelays$ = state<readonly number[]>(
  DEFAULT_FIBONACCI_DELAYS_MS,
);

export const setFibonacciDelaysForTest$ = command(
  ({ set }, delays: readonly number[]) => {
    set(internalFibDelays$, delays);
  },
);

export const fibDelays$ = computed((get) => {
  return get(internalFibDelays$);
});

export async function setLoop(
  loopBody: (signal: AbortSignal) => Promise<boolean>,
  interval: number,
  signal: AbortSignal,
  fibDelays: readonly number[],
): Promise<void> {
  let fibIndex = 0;
  while (true) {
    // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry with backoff
    try {
      const done = await loopBody(signal);
      if (done) {
        return;
      }
      fibIndex = 0;
      await delay(interval, { signal });
    } catch (error) {
      throwIfAbort(error);
      const backoff =
        fibDelays[Math.min(fibIndex, fibDelays.length - 1)] ?? 60_000;
      L.warn(
        `setLoop: transient error (attempt ${fibIndex + 1}), retrying in ${backoff}ms`,
        error,
      );
      fibIndex++;
      await delay(backoff, { signal });
    }
  }
}

const internalPollInterval$ = state(3000);

export const setPollIntervalForTest$ = command(({ set }, interval: number) => {
  set(internalPollInterval$, interval);
});

export const pollInterval$ = computed((get) => {
  return get(internalPollInterval$);
});

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
  since?: string,
  signal?: AbortSignal,
) {
  const query: { limit: number; order: "asc"; since?: number } = {
    limit: AGENT_EVENTS_PAGE_LIMIT,
    order: "asc",
  };
  if (since) {
    query.since = new Date(since).getTime();
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
  since?: string,
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
      // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() error propagation
      try {
        const result = await accept(
          client.getPosition({ query: { runId } }),
          [200],
        );
        return result.body.position;
      } catch (error) {
        throwIfAbort(error);
        return 0;
      }
    }),
    reload$: command(({ set }) => {
      return set(internalReload$, (x) => {
        return x + 1;
      });
    }),
  };
}

function createRunPagedEvents(runId: string) {
  return computed(async (get) => {
    const firstPage = createEventPageComputed(runId);
    const pagedEventsList = [firstPage];

    while (true) {
      const lastPage = await get(pagedEventsList[pagedEventsList.length - 1]);

      if (!lastPage.hasMore) {
        break;
      }

      const lastEvent = lastPage.events[lastPage.events.length - 1];
      const nextPage$ = createEventPageComputed(runId, lastEvent?.createdAt);
      pagedEventsList.push(nextPage$);
    }
    return pagedEventsList;
  });
}

export function createRunLoop(runId: string) {
  const {
    detail$: runDetail$,
    reload$: reloadRunStatus$,
    finished$,
  } = createRunDetail(runId);

  const { queuePosition$, reload$: reloadQueuePosition$ } =
    createQueuePosition(runId);
  const initialRunPagedEvents$ = createRunPagedEvents(runId);
  const internalLoopedPagedEvents$ = state<Computed<Promise<PagedRunEvents>>[]>(
    [],
  );

  const pagedEventsList$ = computed(async (get) => {
    const initial = await get(initialRunPagedEvents$);
    const looped = get(internalLoopedPagedEvents$);
    return [...initial, ...looped];
  });

  const checkFinished$ = command(async ({ set, get }, signal: AbortSignal) => {
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
    const lastPagedEventsLists =
      loopedPagedEvents.length > 0 ? loopedPagedEvents : initialPagedEvents;
    const lastPagedEvents =
      lastPagedEventsLists[lastPagedEventsLists.length - 1] ?? null;
    const since = lastPagedEvents
      ? (await get(lastPagedEvents)).events.slice(-1)[0]?.createdAt
      : undefined;
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
