import { command, computed, state, type Computed } from "ccstate";
import { delay } from "signal-timers";
import {
  activitySummaryResponseSchema,
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
  type ThinkingMessage,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { foldChatRunStates } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import {
  featureSwitch$,
  initialFeatureSwitchHydration$,
} from "../external/feature-switch.ts";
import {
  completeOnLocalAbort,
  createChildAbortController,
  createDeferredPromise,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";

const REQUEST_INTERVAL_MS = 15_000;
const FAILURE_RETRY_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface ThinkingSummaries extends Pick<
  ActivitySummaryResponse,
  | "runId"
  | "summaryRevision"
  | "summarySequence"
  | "summaryMessageCursor"
  | "summarizedAt"
> {
  readonly messages: readonly ThinkingMessage[];
}

function keepPreviousThinkingSummaries(
  previous: ThinkingSummaries | null,
  next: ThinkingSummaries | null,
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next || previous.runId !== next.runId) {
    return false;
  }
  // Only a summary with its own provenance can replace the last good batch.
  // Current source metadata can advance while the cached summary is unchanged.
  return (
    next.messages.length === 0 ||
    next.summaryRevision === null ||
    next.summarizedAt === null ||
    (previous.summarizedAt !== null &&
      next.summarizedAt < previous.summarizedAt) ||
    (next.summarySequence ?? -1) < (previous.summarySequence ?? -1) ||
    (next.summaryMessageCursor ?? -1) < (previous.summaryMessageCursor ?? -1)
  );
}

function createThinkingSummaryRequest(
  threadId: string,
  runId: string,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    signal.throwIfAborted();
    const response = await accept(
      get(apiClient$)(chatThreadActivitySummaryContract).summarize({
        params: { id: threadId },
        body: { runId },
        fetchOptions: { signal },
      }),
      [200, 401, 403, 404],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (response.status !== 200) {
      return null;
    }
    const data = activitySummaryResponseSchema.parse(response.body);
    if (data.runId !== runId || data.status === "unavailable") {
      throw new Error("Activity summary is unavailable for the current run");
    }
    if (data.status === "ineligible") {
      return null;
    }
    return data;
  });
}

function createThinkingSummaryRequests(threadId: string) {
  const request$ = state<ReturnType<
    typeof createThinkingSummaryRequest
  > | null>(null);
  // Retain one fulfilled resource while the optional service is unavailable.
  // The response stays in its async computed; no second mutable response store.
  const lastSuccessfulRequest$ = state<ReturnType<
    typeof createThinkingSummaryRequest
  > | null>(null);
  const thinkingSummaries$ = computed(async (get) => {
    const request = get(request$);
    const previous = get(lastSuccessfulRequest$);
    if (!request) {
      return null;
    }
    const [result] = await Promise.allSettled([get(request)]);
    const previousSummary = previous ? await get(previous) : null;
    return result.status === "fulfilled" &&
      !keepPreviousThinkingSummaries(previousSummary, result.value)
      ? result.value
      : previousSummary;
  });
  const retry$ = state<{
    runId: string | null;
    nextRequestAt: number;
    failures: number;
    blocked: boolean;
  }>({
    runId: null,
    nextRequestAt: 0,
    failures: 0,
    blocked: false,
  });
  const reloadThinkingSummaries$ = command(
    async (
      { get, set },
      runId: string,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const retry = get(retry$);
      if (retry.blocked) {
        return true;
      }
      if (now() < retry.nextRequestAt) {
        return false;
      }
      const request = createThinkingSummaryRequest(threadId, runId, signal);
      set(request$, request);
      // Await the computed so refreshes serialize. Cancellation belongs to the
      // demand lifecycle and must not consume the optional-service retry budget.
      const [result] = await Promise.allSettled([get(request)]);
      signal.throwIfAborted();
      if (result.status === "fulfilled" && result.value === null) {
        set(retry$, { ...retry, blocked: true });
        return true;
      }
      if (result.status === "fulfilled") {
        const previous = get(lastSuccessfulRequest$);
        const previousSummary = previous ? await get(previous) : null;
        signal.throwIfAborted();
        if (!keepPreviousThinkingSummaries(previousSummary, result.value)) {
          set(lastSuccessfulRequest$, request);
        }
      }
      const failed = result.status === "rejected";
      const failures = failed ? retry.failures + 1 : 0;
      set(retry$, {
        runId,
        failures,
        blocked: failures >= MAX_CONSECUTIVE_FAILURES,
        nextRequestAt:
          now() +
          Math.max(
            REQUEST_INTERVAL_MS,
            result.status === "fulfilled"
              ? (result.value?.retryAfterMs ?? 0)
              : FAILURE_RETRY_MS,
          ),
      });
      return failures >= MAX_CONSECUTIVE_FAILURES;
    },
  );
  const resetForRun$ = command(({ get, set }, runId: string | null) => {
    if (get(retry$).runId !== runId) {
      set(retry$, { runId, nextRequestAt: 0, failures: 0, blocked: false });
      set(request$, null);
      set(lastSuccessfulRequest$, null);
    }
  });
  const blocked$ = computed((get) => {
    return get(retry$).blocked;
  });
  return {
    thinkingSummaries$,
    reloadThinkingSummaries$,
    resetForRun$,
    blocked$,
  };
}

function createThinkingSummarySubscription(
  runId$: Computed<string | null>,
  chatEvents$: Computed<ChatEvent[]>,
  requests: ReturnType<typeof createThinkingSummaryRequests>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    let demandRunId: string | null = null;
    let demandController = createChildAbortController(signal);
    let changed = createDeferredPromise<void>(signal);
    // eslint-disable-next-line ccstate/no-command-in-command -- migrate this runtime callback to the static command graph
    const updateDemand$ = command(({ get, set }) => {
      signal.throwIfAborted();
      const runId = get(runId$);
      if (runId !== demandRunId) {
        demandController.abort();
        demandController = createChildAbortController(signal);
        demandRunId = runId;
        changed.resolve();
        changed = createDeferredPromise<void>(signal);
      }
      set(requests.resetForRun$, runId);
    });
    // eslint-disable-next-line ccstate/no-command-in-command -- migrate this runtime callback to the static command graph
    const afterEventsChange$ = command(({ set }) => {
      set(updateDemand$);
      return Promise.resolve();
    });
    set(
      registerChatEventChangeHandler$,
      chatEvents$,
      afterEventsChange$,
      signal,
    );
    set(updateDemand$);

    // Bootstrap can replace cached switch state after this thread starts.
    // eslint-disable-next-line ccstate/no-command-in-command -- migrate this runtime callback to the static command graph
    const hydrateDemand$ = command(
      async ({ get, set }, signal: AbortSignal) => {
        await get(initialFeatureSwitchHydration$);
        signal.throwIfAborted();
        set(updateDemand$);
      },
    );
    await withCleanup(
      Promise.all([
        set(hydrateDemand$, signal),
        setLoop(
          async () => {
            set(updateDemand$);
            const runId = demandRunId;
            const demandSignal = demandController.signal;
            if (runId && !get(requests.blocked$)) {
              await completeOnLocalAbort(
                setLoop(
                  async () => {
                    set(updateDemand$);
                    demandSignal.throwIfAborted();
                    return await set(
                      requests.reloadThinkingSummaries$,
                      runId,
                      demandSignal,
                    );
                  },
                  REQUEST_INTERVAL_MS,
                  demandSignal,
                  { retryTransientErrors: false },
                ),
                demandSignal,
                signal,
              );
              signal.throwIfAborted();
            } else {
              // Idle threads issue no requests. Run events wake the owner; the
              // bounded check also observes subsequent switch changes.
              const idleController = createChildAbortController(signal);
              await withCleanup(
                Promise.race([
                  changed.promise,
                  delay(REQUEST_INTERVAL_MS, { signal: idleController.signal }),
                ]),
                () => {
                  idleController.abort();
                },
              );
              signal.throwIfAborted();
            }
            return false;
          },
          0,
          signal,
          { retryTransientErrors: false },
        ),
      ]),
      () => {
        demandController.abort();
      },
    );
  });
}

export function createThreadActivitySummarySignals(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ThreadActivitySummary] === true;
  });
  const runId$ = computed((get): string | null => {
    if (
      !get(enabled$) ||
      get(currentChatThreadId$) !== threadId ||
      get(threadMeta$) === null
    ) {
      return null;
    }
    const events = get(chatEvents$);
    const states = foldChatRunStates(events);
    return (
      liveRunIdsFromChatEvents(events)
        .filter((id) => {
          return states.get(id) !== "queued";
        })
        .at(-1) ?? null
    );
  });
  const requests = createThinkingSummaryRequests(threadId);

  return {
    subscribe$: createThinkingSummarySubscription(
      runId$,
      chatEvents$,
      requests,
    ),
    enabled$,
    thinkingSummaries$: requests.thinkingSummaries$,
    thinkingRunId$: runId$,
  };
}
