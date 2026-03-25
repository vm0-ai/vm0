import { command, computed, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "./log-types.ts";
import { delay } from "signal-timers";
import { zeroRunAgentEventsContract, logsByIdContract } from "@vm0/core";
import { throwIfAbort } from "../utils.ts";
import { zeroClient$ } from "../api-client.ts";

const AGENT_EVENTS_PAGE_LIMIT = 30;
const MAX_INTERVAL = 30_000;
const BASE_POLL_INTERVAL = 3000;

// ---------------------------------------------------------------------------
// Terminal status helper
// ---------------------------------------------------------------------------

function isTerminalStatus(status: string | null): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

// ---------------------------------------------------------------------------
// Page result & factory
// ---------------------------------------------------------------------------

export interface PageResult {
  events: AgentEvent[];
  hasMore: boolean;
}

function createEventPageComputed(
  runId: string,
  since?: string,
): Computed<Promise<PageResult>> {
  return computed(async (get) => {
    const client = get(zeroClient$)(zeroRunAgentEventsContract);
    const query: { limit: number; order: "asc"; since?: number } = {
      limit: AGENT_EVENTS_PAGE_LIMIT,
      order: "asc",
    };
    if (since) {
      query.since = new Date(since).getTime();
    }
    const result = await client.getAgentEvents({
      params: { id: runId },
      query,
    });
    if (result.status !== 200) {
      throw new Error(`Failed to fetch agent events (${result.status})`);
    }
    const data = result.body;
    return { events: data.events, hasMore: data.hasMore };
  });
}

// ---------------------------------------------------------------------------
// Poll for new events (append a page if new events exist)
// ---------------------------------------------------------------------------

interface PollableRunState {
  events$: Computed<Promise<PageResult>>[];
  setEvents: (
    updater: (
      prev: Computed<Promise<PageResult>>[],
    ) => Computed<Promise<PageResult>>[],
  ) => void;
  setStatus: (status: LogStatus) => void;
  setError?: (error: string | null) => void;
}

const pollNewEvents$ = command(
  async (
    { get },
    args: { runId: string; state: PollableRunState },
    _signal: AbortSignal,
  ) => {
    const { runId, state: runState } = args;
    const pages = runState.events$;
    if (pages.length === 0) {
      return;
    }

    const lastPage = await get(pages[pages.length - 1]);
    if (lastPage.events.length === 0) {
      const freshPage = createEventPageComputed(runId);
      runState.setEvents(() => [freshPage]);
      return;
    }

    const lastEvent = lastPage.events[lastPage.events.length - 1];
    const newPage = createEventPageComputed(runId, lastEvent.createdAt);
    const newPageResult = await get(newPage);

    if (newPageResult.events.length > 0) {
      runState.setEvents((prev) => [...prev, newPage]);
    }
  },
);

// ---------------------------------------------------------------------------
// Three-phase polling loop
// ---------------------------------------------------------------------------

export const setupPollingLoop$ = command(
  async (
    { get, set },
    config: {
      runId: string;
      state: PollableRunState;
      onTerminal?: (runId: string) => void;
      onPhase2Done?: () => void;
    },
    signal: AbortSignal,
  ) => {
    const { runId, state: runState, onTerminal, onPhase2Done } = config;

    // Phase 1: Eager initial load — fetch all existing event pages
    const firstPage = createEventPageComputed(runId);
    runState.setEvents(() => [firstPage]);

    let keepLoading = true;
    while (keepLoading && !signal.aborted) {
      const pages = runState.events$;
      const lastPage = await get(pages[pages.length - 1]);
      signal.throwIfAborted();
      if (lastPage.hasMore && lastPage.events.length > 0) {
        const lastEvent = lastPage.events[lastPage.events.length - 1];
        const nextPage = createEventPageComputed(runId, lastEvent.createdAt);
        runState.setEvents((prev) => [...prev, nextPage]);
      } else {
        keepLoading = false;
      }
    }

    // Phase 2: Check if already terminal
    try {
      const client = get(zeroClient$)(logsByIdContract);
      const result = await client.getById({ params: { id: runId } });
      signal.throwIfAborted();
      if (result.status === 200) {
        runState.setStatus(result.body.status);
        runState.setError?.(result.body.error);
        if (isTerminalStatus(result.body.status)) {
          await set(pollNewEvents$, { runId, state: runState }, signal);
          signal.throwIfAborted();
          onTerminal?.(runId);
          return;
        }
      }
    } catch (error) {
      throwIfAbort(error);
    } finally {
      onPhase2Done?.();
    }

    // Phase 3: Polling loop
    let errorCount = 0;

    while (!signal.aborted) {
      const interval = Math.min(
        BASE_POLL_INTERVAL * 2 ** errorCount,
        MAX_INTERVAL,
      );

      await delay(interval, { signal });
      signal.throwIfAborted();

      try {
        const client = get(zeroClient$)(logsByIdContract);
        const result = await client.getById({ params: { id: runId } });
        signal.throwIfAborted();

        if (result.status === 200) {
          runState.setStatus(result.body.status);
          runState.setError?.(result.body.error);
          if (isTerminalStatus(result.body.status)) {
            await set(pollNewEvents$, { runId, state: runState }, signal);
            signal.throwIfAborted();
            onTerminal?.(runId);
            return;
          }
        }

        await set(pollNewEvents$, { runId, state: runState }, signal);
        signal.throwIfAborted();
        errorCount = 0;
      } catch (error) {
        throwIfAbort(error);
        errorCount++;
      }
    }
  },
);
