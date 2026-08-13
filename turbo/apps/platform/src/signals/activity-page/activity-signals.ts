import { command, computed, state } from "ccstate";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";
import { pathParams$ } from "../route.ts";
import { onRef, setLoop } from "../utils.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogStatus,
} from "../zero-page/log-types.ts";
import { groupVisibleGroups, type EventGroup } from "./log-detail-utils.ts";
import {
  formatActivityClockTime,
  formatActivityDurationMs,
} from "./activity-time.ts";

const AGENT_EVENTS_PAGE_LIMIT = 100;
const AGENT_EVENTS_POLL_INTERVAL_MS = 1000;

type AgentEventsClient = InitClientReturn<
  typeof zeroRunAgentEventsContract,
  InitClientArgs
>;

interface ZeroActivityEvents {
  readonly runId: string;
  readonly events: AgentEvent[];
  readonly status: LogStatus;
  readonly lastEventSequence: number | null;
}

interface ZeroActivityVisibleGroups {
  readonly runId: string | null;
  readonly groups: EventGroup[];
}

export const currentRunId$ = computed((get) => {
  const params = get(pathParams$);
  if (params && typeof params === "object" && "activityRunId" in params) {
    return String(params.activityRunId);
  }
  return null;
});

async function fetchAllAgentEvents(
  client: AgentEventsClient,
  runId: string,
  signal: AbortSignal,
): Promise<Omit<ZeroActivityEvents, "runId">> {
  const seenCursors = new Set<string>();
  const firstPage = await accept(
    client.getAgentEvents({
      params: { id: runId },
      query: {
        limit: AGENT_EVENTS_PAGE_LIMIT,
        order: "asc",
      },
      fetchOptions: { signal },
    }),
    [200],
  );
  const events = [...firstPage.body.events];
  let page: AgentEventsResponse = firstPage.body;

  while (page.hasMore) {
    const nextCursor = page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Agent event pagination cursor did not advance");
    }
    seenCursors.add(nextCursor);
    const result = await accept(
      client.getAgentEvents({
        params: { id: runId },
        query: {
          limit: AGENT_EVENTS_PAGE_LIMIT,
          order: "asc",
          cursor: nextCursor,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    events.push(...result.body.events);
    page = result.body;
  }

  return {
    events,
    status: page.status,
    lastEventSequence: page.lastEventSequence,
  };
}

const internalActivityEventsReload$ = state(0);

export const zeroActivityEvents$ = computed(async (get) => {
  get(internalActivityEventsReload$);
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const client = get(zeroClient$)(zeroRunAgentEventsContract);
  const signal = get(pageSignal$);
  return {
    runId,
    ...(await fetchAllAgentEvents(client, runId, signal)),
  } satisfies ZeroActivityEvents;
});

function isTerminalStatus(status: LogStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

function visibleEventSequence(events: readonly AgentEvent[]): number {
  let visibleThrough = -1;
  for (const event of events) {
    if (event.sequenceNumber <= visibleThrough) {
      continue;
    }
    if (event.sequenceNumber !== visibleThrough + 1) {
      break;
    }
    visibleThrough = event.sequenceNumber;
  }
  return visibleThrough;
}

function reachedTerminalEventWatermark(data: ZeroActivityEvents): boolean {
  if (!isTerminalStatus(data.status)) {
    return false;
  }
  return (
    data.lastEventSequence === null ||
    visibleEventSequence(data.events) >= data.lastEventSequence
  );
}

const pollActivityEvents$ = command(
  async ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
    let shouldReload = false;
    await setLoop(
      async (loopSignal) => {
        if (shouldReload) {
          set(internalActivityEventsReload$, (current) => {
            return current + 1;
          });
        }
        shouldReload = true;
        const events = await get(zeroActivityEvents$);
        loopSignal.throwIfAborted();
        if (!events || reachedTerminalEventWatermark(events)) {
          return true;
        }
        return false;
      },
      AGENT_EVENTS_POLL_INTERVAL_MS,
      signal,
    );
  },
);

export const activityEventsPollerRef$ = onRef(pollActivityEvents$);

export const zeroActivityDetail$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const result = await accept(
    get(zeroClient$)(logsByIdContract).getById({
      params: { id: runId },
    }),
    [200],
  );
  return result.body;
});

const internalStepSearch$ = state("");

export const zeroActivityStepSearch$ = computed((get) => {
  return get(internalStepSearch$);
});

export const setZeroActivityStepSearch$ = command(({ set }, value: string) => {
  set(internalStepSearch$, value);
});

export const zeroActivityVisibleGroups$ = computed(async (get) => {
  const [detail, events] = await Promise.all([
    get(zeroActivityDetail$),
    get(zeroActivityEvents$),
  ]);
  if (!detail || !events || events.runId !== detail.id) {
    return {
      runId: events?.runId ?? null,
      groups: [],
    } satisfies ZeroActivityVisibleGroups;
  }
  return {
    runId: detail.id,
    groups: groupVisibleGroups(events.events, {
      framework: detail.framework,
    }),
  } satisfies ZeroActivityVisibleGroups;
});

export function formatLogTime(createdAt: string): string {
  return formatActivityClockTime(createdAt);
}

export function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
): string | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  return formatActivityDurationMs(ms);
}
