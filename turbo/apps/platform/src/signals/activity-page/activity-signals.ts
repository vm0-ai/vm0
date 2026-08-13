import { command, computed, state } from "ccstate";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import type { AgentEvent } from "../zero-page/log-types.ts";
import { groupVisibleGroups, type EventGroup } from "./log-detail-utils.ts";
import {
  formatActivityClockTime,
  formatActivityDurationMs,
} from "./activity-time.ts";

const AGENT_EVENTS_PAGE_LIMIT = 100;

type AgentEventsClient = InitClientReturn<
  typeof zeroRunAgentEventsContract,
  InitClientArgs
>;

interface ZeroActivityEvents {
  readonly runId: string;
  readonly events: AgentEvent[];
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
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const result = await accept(
      client.getAgentEvents({
        params: { id: runId },
        query: {
          limit: AGENT_EVENTS_PAGE_LIMIT,
          order: "asc",
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
      [200],
    );
    events.push(...result.body.events);

    if (!result.body.hasMore) {
      return events;
    }

    const nextCursor = result.body.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Agent event pagination cursor did not advance");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export const zeroActivityEvents$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const client = get(zeroClient$)(zeroRunAgentEventsContract);
  return {
    runId,
    events: await fetchAllAgentEvents(client, runId),
  } satisfies ZeroActivityEvents;
});

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
