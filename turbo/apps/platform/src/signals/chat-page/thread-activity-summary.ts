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
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";
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

function createThinkingSummaryDemand(
  threadId: string,
  currentActiveRunId$: Computed<string | null>,
  chatEvents$: Computed<ChatEvent[]>,
) {
  const internalReloadDemandSummary$ = state(0);
  const summaryDemandRunId$ = state<string | null>(null);
  const resetSummaryDemand$ = resetSignal();
  let summaryDemandSignal: AbortSignal | null = null;
  // eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
  const demandSummaries$ = computed(async (get) => {
    get(internalReloadDemandSummary$);
    const runId = get(summaryDemandRunId$);
    const signal = summaryDemandSignal;
    if (!runId || !signal) {
      return null;
    }
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
  const startSummaryDemand$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const [completion] = await Promise.allSettled([
        setLoop(
          () => {
            set(internalReloadDemandSummary$, (version) => {
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
  const subscribe$ = command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    let activeDemand = Promise.resolve();
    const ensureSummaryDemand$ = command(
      async ({ get, set }, demandOwnerSignal: AbortSignal) => {
        demandOwnerSignal.throwIfAborted();
        const runId = get(currentActiveRunId$);
        if (runId === get(summaryDemandRunId$)) {
          return;
        }
        summaryDemandSignal = null;
        const previousDemand = activeDemand;
        const demandSignal = set(resetSummaryDemand$, demandOwnerSignal);
        set(summaryDemandRunId$, runId);
        await previousDemand;
        demandOwnerSignal.throwIfAborted();
        if (runId !== get(summaryDemandRunId$)) {
          return;
        }
        if (runId) {
          summaryDemandSignal = demandSignal;
          activeDemand = set(startSummaryDemand$, demandSignal);
        }
      },
    );
    const afterEventsChange$ = command(({ set }) => {
      return set(ensureSummaryDemand$, signal);
    });
    set(
      registerChatEventChangeHandler$,
      chatEvents$,
      afterEventsChange$,
      signal,
    );
    const ensureHydratedSummaryDemand$ = command(
      async ({ get, set }, signal: AbortSignal) => {
        await get(initialFeatureSwitchHydration$);
        signal.throwIfAborted();
        await set(ensureSummaryDemand$, signal);
      },
    );
    const subscriptionEnd = createDeferredPromise<void>(signal);
    await withCleanup(
      Promise.all([
        set(ensureSummaryDemand$, signal),
        set(ensureHydratedSummaryDemand$, signal),
        subscriptionEnd.promise,
      ]),
      async () => {
        set(resetSummaryDemand$);
        await activeDemand;
      },
    );
  });

  return { demandSummaries$, subscribe$, summaryDemandRunId$ };
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
  const demand = createThinkingSummaryDemand(
    threadId,
    currentActiveRunId$,
    chatEvents$,
  );

  return {
    subscribe$: demand.subscribe$,
    enabled$,
    thinkingSummaries$: demand.demandSummaries$,
    thinkingRunId$: demand.summaryDemandRunId$,
  };
}
