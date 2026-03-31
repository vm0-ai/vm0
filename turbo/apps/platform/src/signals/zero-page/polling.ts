import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent } from "./log-types.ts";
import { delay } from "signal-timers";
import {
  zeroRunAgentEventsContract,
  logsByIdContract,
  zeroQueuePositionContract,
  zeroRunsCancelContract,
} from "@vm0/core";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";

const AGENT_EVENTS_PAGE_LIMIT = 30;

const internalPollInterval$ = state(3000);

export const setPollIntervalForTest$ = command(({ set }, interval: number) => {
  set(internalPollInterval$, interval);
});

const poolInterval$ = computed((get) => get(internalPollInterval$));

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
  const result = await client(zeroRunAgentEventsContract).getAgentEvents({
    params: { id: runId },
    query,
    fetchOptions: {
      signal,
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to fetch agent events (${result.status})`);
  }
  const data = result.body;
  return { events: data.events, hasMore: data.hasMore };
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
    const result = await client.getById({
      params: { id: runId },
    });
    if (result.status !== 200) {
      throw new Error(`Failed to fetch run status (${result.status})`);
    }
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
    reload$: command(({ set }) => set(internalReloadRunStatus$, (x) => x + 1)),
  };
}

function createQueuePosition(runId: string) {
  const internalReload$ = state(0);

  return {
    queuePosition$: computed(async (get) => {
      const createClient = get(zeroClient$);
      const client = createClient(zeroQueuePositionContract);
      const result = await client.getPosition({ query: { runId } });
      if (result.status !== 200) {
        return 0;
      }
      return result.body.position;
    }),
    reload$: command(({ set }) => set(internalReload$, (x) => x + 1)),
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

const THINKING_MESSAGES = [
  "On it, grab a coffee",
  "Thinking hard...",
  "Cooking up something good...",
  "Give me a sec...",
  "Working my magic...",
  "Hang tight...",
  "Let me figure this out...",
  "Brewing ideas...",
  "Crunching the numbers...",
  "Just a moment...",
] as const;

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

  const reloadThinkingMessage$ = state(0);

  const thinkingMessage$ = computed((get) => {
    get(reloadThinkingMessage$);
    return THINKING_MESSAGES[
      Math.floor(Math.random() * THINKING_MESSAGES.length)
    ];
  });

  const beginLoop$ = command(async ({ set, get }, signal: AbortSignal) => {
    let status = (await get(runDetail$)).status;
    signal.throwIfAborted();

    while (status === "pending") {
      await delay(get(poolInterval$), { signal });
      set(reloadRunStatus$);
      set(reloadQueuePosition$);
      status = (await get(runDetail$)).status;
      signal.throwIfAborted();
    }

    const initialPagedEvents = await get(initialRunPagedEvents$);
    signal.throwIfAborted();

    while (true) {
      // First, we need to check the "finish" status. If it has finished,
      // we still need to pull the chat data from the page one last time.
      // This ensures that the final set of data is successfully included.
      const finished = await get(finished$);
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
      set(internalLoopedPagedEvents$, (prev) => [...prev, nextPage$]);

      await delay(get(poolInterval$), { signal });
      set(reloadRunStatus$);
      set(reloadThinkingMessage$, (x) => x + 1);

      const lastPage = await get(nextPage$);
      signal.throwIfAborted();
      if (finished && !lastPage.hasMore) {
        break;
      }
    }
  });

  const cancel$ = command(async ({ get }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroRunsCancelContract);
    await client.cancel({
      params: { id: runId },
      fetchOptions: { signal },
    });
  });

  return {
    pagedEventsList$,
    beginLoop$,
    cancel$,
    detail$: runDetail$,
    queuePosition$,
    finished$,
    thinkingMessage$,
  };
}
