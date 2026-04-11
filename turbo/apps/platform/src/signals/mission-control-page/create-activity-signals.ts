import { command, computed, state, type Command, type Computed } from "ccstate";
import { createRunLoop } from "../zero-page/polling.ts";
import { setLoop } from "../utils.ts";
import type { LogDetail, AgentEvent } from "../zero-page/log-types.ts";

// ---------------------------------------------------------------------------
// ActivitySignals — returned by createActivitySignals
// ---------------------------------------------------------------------------

export interface ActivitySignals {
  detail$: Computed<Promise<LogDetail>>;
  events$: Computed<Promise<AgentEvent[]>>;
  stepSearch$: Computed<string>;
  setStepSearch$: Command<void, [string]>;
  startPolling$: Command<Promise<void>, [AbortSignal]>;
  focusInput$: Command<void, []>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createActivitySignals(runId: string): ActivitySignals {
  const runLoop = createRunLoop(runId);

  const detail$ = runLoop.detail$;

  const events$ = computed(async (get) => {
    const pages = await get(runLoop.pagedEventsList$);
    if (pages.length === 0) {
      return [] as AgentEvent[];
    }
    const results = await Promise.all(
      pages.map((p) => {
        return get(p);
      }),
    );
    return results.flatMap((r) => {
      return r.events;
    });
  });

  const internalStepSearch$ = state("");

  const stepSearch$ = computed((get) => {
    return get(internalStepSearch$);
  });

  const setStepSearch$ = command(({ set }, value: string) => {
    set(internalStepSearch$, value);
  });

  const startPolling$ = command(async ({ set }, signal: AbortSignal) => {
    await setLoop(
      (sig) => {
        return set(runLoop.checkFinished$, sig);
      },
      3000,
      signal,
    );
  });

  const focusInput$ = command(() => {});

  return {
    detail$,
    events$,
    stepSearch$,
    setStepSearch$,
    startPolling$,
    focusInput$,
  };
}
