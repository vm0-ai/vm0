import { command, computed, state, type Computed } from "ccstate";
import {
  activitySummaryResponseSchema,
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
  type ThinkingMessage,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { foldChatRunStates } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import {
  featureSwitch$,
  initialFeatureSwitchHydration$,
} from "../external/feature-switch.ts";
import {
  createDeferredPromise,
  resetSignal,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";

const REQUEST_INTERVAL_MS = 15_000;

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

function createThreadSummaryDemand(
  threadId: string,
  currentActiveRunId$: Computed<string | null>,
) {
  const internalReloadThreadSummaries$ = state(0);
  const summaryLoopRunId$ = state<string | null>(null);
  const resetSummaryDemand$ = resetSignal();
  const threadSummaries$ = computed(async (get) => {
    const runId = get(currentActiveRunId$);
    if (runId === null) {
      return null;
    }
    // Run changes invalidate this computed directly. The reload dependency only
    // drives interval refreshes while this thread has summary demand.
    get(internalReloadThreadSummaries$);
    const response = await accept(
      get(apiClient$)(chatThreadActivitySummaryContract).summarize({
        params: { id: threadId },
        body: { runId },
      }),
      [200, 401, 403, 404],
      undefined,
      { showErrorToast: false },
    );
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
  const startSummaryLoop$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const [completion] = await Promise.allSettled([
        setLoop(
          () => {
            set(internalReloadThreadSummaries$, (version) => {
              return version + 1;
            });
            return false;
          },
          REQUEST_INTERVAL_MS,
          signal,
          { testIntervalMs: 100 },
        ),
      ]);
      if (signal.aborted) {
        return;
      }
      if (completion.status === "rejected") {
        throw completion.reason;
      }
    },
  );
  const reconcileThreadSummaryDemand$ = command(
    ({ get, set }, demandOwnerSignal: AbortSignal): void => {
      demandOwnerSignal.throwIfAborted();
      const runId = get(currentActiveRunId$);
      if (runId === get(summaryLoopRunId$)) {
        return;
      }
      const loopSignal = set(resetSummaryDemand$, demandOwnerSignal);
      set(summaryLoopRunId$, runId);
      if (runId !== null) {
        set(startSummaryLoop$, loopSignal);
      }
    },
  );
  const reconcileHydratedThreadSummaryDemand$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await get(initialFeatureSwitchHydration$);
      signal.throwIfAborted();
      set(reconcileThreadSummaryDemand$, signal);
    },
  );
  const subscribe$ = command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reconcileThreadSummaryDemand$, signal);
    const subscriptionEnd = createDeferredPromise<void>(signal);
    await withCleanup(
      Promise.all([
        set(reconcileHydratedThreadSummaryDemand$, signal),
        subscriptionEnd.promise,
      ]),
      () => {
        set(summaryLoopRunId$, null);
        set(resetSummaryDemand$);
      },
    );
  });

  return { threadSummaries$, reconcileThreadSummaryDemand$, subscribe$ };
}

export function createThreadActivitySummarySignals(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ThreadActivitySummary] === true;
  });
  const currentActiveRunId$ = computed((get): string | null => {
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
  const demand = createThreadSummaryDemand(threadId, currentActiveRunId$);

  return {
    subscribe$: demand.subscribe$,
    reconcileThreadSummaryDemand$: demand.reconcileThreadSummaryDemand$,
    enabled$,
    thinkingSummaries$: demand.threadSummaries$,
    thinkingRunId$: currentActiveRunId$,
  };
}
