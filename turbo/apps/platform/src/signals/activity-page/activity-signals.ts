import { command, computed, state } from "ccstate";
import type { AgentEvent } from "../zero-page/log-types.ts";
import { pathParams$ } from "../route.ts";
import { createRunLoop } from "../zero-page/polling.ts";
import { delay } from "signal-timers";
import { groupVisibleGroups, type EventGroup } from "./log-detail-utils.ts";
import { scrollToBottomActivityDetail$ } from "./activity-detail-scroll.ts";
import {
  formatActivityClockTime,
  formatActivityDurationMs,
} from "./activity-time.ts";

export const currentRunId$ = computed((get) => {
  const params = get(pathParams$);
  if (params && typeof params === "object" && "activityRunId" in params) {
    return String(params.activityRunId);
  }
  return null;
});

// ---------------------------------------------------------------------------
// Detail step search — component-local filter for the detail view
// ---------------------------------------------------------------------------

const internalStepSearch$ = state("");

/** Current step search filter for the activity detail view. */
export const zeroActivityStepSearch$ = computed((get) => {
  return get(internalStepSearch$);
});

/** Update the step search filter. */
export const setZeroActivityStepSearch$ = command(({ set }, value: string) => {
  set(internalStepSearch$, value);
});

/**
 * Active run data for the currently selected log.
 */
const internalActiveRunLoop$ = state<ReturnType<typeof createRunLoop> | null>(
  null,
);

/**
 * Set selected log ID directly and trigger the initial detail fetch.
 */
export const setupActivityLogLoop$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalActiveRunLoop$, null);
    });

    const runId = get(currentRunId$);
    if (!runId) {
      return;
    }

    const run = createRunLoop(runId);
    set(internalActiveRunLoop$, run);
    // Yield one microtask tick so React can flush the run detail panel into the
    // DOM before we trigger scrollToBottomActivityDetail$. Without this yield
    // the scroll container may still reflect the previous layout and the scroll
    // would be a no-op.
    await delay(0, { signal });
    set(scrollToBottomActivityDetail$);
  },
);

// ---------------------------------------------------------------------------
// Log detail
// ---------------------------------------------------------------------------

export const zeroActivityDetail$ = computed(async (get) => {
  const run = get(internalActiveRunLoop$);
  if (!run) {
    return null;
  }

  return await get(run.detail$);
});

// ---------------------------------------------------------------------------
// Events — flattened from run loop's paged events
// ---------------------------------------------------------------------------

interface ZeroActivityEvents {
  runId: string;
  events: AgentEvent[];
}

export const zeroActivityEvents$ = computed(async (get) => {
  const run = get(internalActiveRunLoop$);
  if (!run) {
    // Return null (not []) so useLastLoadable won't treat a stale empty array
    // as "hasData" while the real events are still loading.
    return null;
  }
  const pages = await get(run.pagedEventsList$);
  if (pages.length === 0) {
    return {
      runId: run.runId,
      events: [],
    } satisfies ZeroActivityEvents;
  }
  const results = await Promise.all(
    pages.map((p) => {
      return get(p);
    }),
  );
  return {
    runId: run.runId,
    events: results.flatMap((r) => {
      return r.events;
    }),
  } satisfies ZeroActivityEvents;
});

interface ZeroActivityVisibleGroups {
  runId: string | null;
  groups: EventGroup[];
}

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

// ---------------------------------------------------------------------------
// Helpers for display conversion
// ---------------------------------------------------------------------------

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
