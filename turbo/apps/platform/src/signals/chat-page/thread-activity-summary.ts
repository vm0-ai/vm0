import { command, computed, state, type Computed, type State } from "ccstate";
import {
  activitySummaryResponseSchema,
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { foldChatRunStates } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { createChildAbortController, setLoop, settle } from "../utils.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";

const REQUEST_INTERVAL_MS = 15_000;
const FAILURE_RETRY_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type Summary = Pick<
  ActivitySummaryResponse,
  | "runId"
  | "phrase"
  | "summaryRevision"
  | "summarySequence"
  | "summaryMessageCursor"
  | "summarizedAt"
>;

function canReplaceSummary(previous: Summary | null, next: Summary): boolean {
  if (previous === null || previous.runId !== next.runId) {
    return true;
  }
  // Hashes are opaque. Compare the actual summary's provenance, never the
  // potentially newer sourceRevision carried alongside a cached phrase.
  return (
    next.summarizedAt !== null &&
    (previous.summarizedAt === null ||
      next.summarizedAt >= previous.summarizedAt) &&
    (next.summarySequence ?? -1) >= (previous.summarySequence ?? -1) &&
    (next.summaryMessageCursor ?? -1) >= (previous.summaryMessageCursor ?? -1)
  );
}

function createSummaryRequestSignals(
  threadId: string,
  runId$: Computed<string | null>,
  visible$: State<boolean>,
) {
  const summary$ = state<Summary | null>(null);
  const blockedRun$ = state<string | null>(null);
  const requestCompletion$ = state<Promise<unknown>>(Promise.resolve());
  const request$ = command(
    async ({ get, set }, runId: string, signal: AbortSignal) => {
      // A detached ref may still be settling an aborted transport. Serialize
      // across ref/visibility/run replacement as well as inside each loop.
      await Promise.allSettled([get(requestCompletion$)]);
      signal.throwIfAborted();
      if (get(runId$) !== runId || !get(visible$)) {
        return { stop: true, failed: false, retryAfterMs: 0 };
      }
      const completion = settle(
        accept(
          get(apiClient$)(chatThreadActivitySummaryContract).summarize({
            params: { id: threadId },
            body: { runId },
            fetchOptions: { signal },
          }),
          [200, 401, 403, 404, 500],
          signal,
          { showErrorToast: false },
        ),
        signal,
      );
      set(requestCompletion$, completion);
      const result = await completion;
      signal.throwIfAborted();
      if (get(runId$) !== runId || !get(visible$)) {
        return { stop: true, failed: false, retryAfterMs: 0 };
      }
      if (!result.ok || result.value.status === 500) {
        return { stop: false, failed: true, retryAfterMs: FAILURE_RETRY_MS };
      }
      const response = result.value;
      if (response.status !== 200) {
        // Includes an older API without the additive endpoint. No cache is
        // exposed and no retry occurs for this identity. #32819 owns verifying
        // API rollback targets before retiring the mixed-version fallback.
        set(summary$, null);
        set(blockedRun$, runId);
        return { stop: true, failed: false, retryAfterMs: 0 };
      }
      const parsed = activitySummaryResponseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.runId !== runId) {
        return { stop: false, failed: true, retryAfterMs: FAILURE_RETRY_MS };
      }
      const data = parsed.data;
      if (data.status === "ineligible") {
        set(summary$, null);
        set(blockedRun$, runId);
        return { stop: true, failed: false, retryAfterMs: 0 };
      }
      if (
        data.phrase &&
        data.summaryRevision !== null &&
        data.summarizedAt !== null &&
        canReplaceSummary(get(summary$), data)
      ) {
        set(summary$, {
          runId,
          phrase: data.phrase,
          summaryRevision: data.summaryRevision,
          summarySequence: data.summarySequence,
          summaryMessageCursor: data.summaryMessageCursor,
          summarizedAt: data.summarizedAt,
        });
      }
      return {
        stop: false,
        failed: data.status === "unavailable",
        retryAfterMs: Math.max(
          data.retryAfterMs,
          data.status === "unavailable"
            ? FAILURE_RETRY_MS
            : REQUEST_INTERVAL_MS,
        ),
      };
    },
  );

  return { summary$, blockedRun$, request$ };
}

export function createThreadActivitySummarySignals(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const visible$ = state(false);
  const retry$ = state<{
    runId: string | null;
    nextRequestAt: number;
    failures: number;
  }>({ runId: null, nextRequestAt: 0, failures: 0 });
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
    // Reuse the run lifecycle fold: optimistic unassociated sends, queue
    // markers, interrupted/terminal runs and historical rounds aren't demand.
    return (
      liveRunIdsFromChatEvents(events)
        .filter((id) => {
          return states.get(id) !== "queued";
        })
        .at(-1) ?? null
    );
  });
  const { summary$, blockedRun$, request$ } = createSummaryRequestSignals(
    threadId,
    runId$,
    visible$,
  );
  const currentSummary$ = computed((get) => {
    const summary = get(summary$);
    return summary?.runId === get(runId$) ? summary : null;
  });
  const thinkingText$ = computed((get) => {
    return get(currentSummary$)?.phrase ?? null;
  });
  const thinkingId$ = computed((get) => {
    const summary = get(currentSummary$);
    // Text equality keeps the existing typewriter mounted even when a newer
    // summary revision produces the same phrase. A changed phrase remounts it.
    return summary?.phrase ? `${summary.runId}:${summary.phrase}` : null;
  });

  const attach$ = computed((get) => {
    const runId = get(runId$);
    const visible = get(visible$);
    return command(
      async ({ get, set }, el: HTMLElement, signal: AbortSignal) => {
        const doc = el.ownerDocument;
        const demand = createChildAbortController(signal);
        const updateVisibility = () => {
          if (doc.visibilityState !== "visible") {
            demand.abort();
          }
          set(visible$, doc.visibilityState === "visible");
        };
        doc.addEventListener("visibilitychange", updateVisibility, { signal });
        updateVisibility();
        if (get(summary$)?.runId !== runId) {
          set(summary$, null);
        }
        if (get(blockedRun$) !== runId) {
          set(blockedRun$, null);
        }
        if (get(retry$).runId !== runId) {
          set(retry$, { runId, nextRequestAt: 0, failures: 0 });
        }
        if (!runId || !visible || get(blockedRun$) === runId) {
          return;
        }
        await setLoop(
          async () => {
            const retry = get(retry$);
            if (now() < retry.nextRequestAt) {
              return false;
            }
            const outcome = await set(request$, runId, demand.signal);
            const failures = outcome.failed ? retry.failures + 1 : 0;
            if (outcome.stop) {
              return true;
            }
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
              set(blockedRun$, runId);
              return true;
            }
            set(retry$, {
              runId,
              failures,
              nextRequestAt:
                now() + Math.max(REQUEST_INTERVAL_MS, outcome.retryAfterMs),
            });
            return false;
          },
          REQUEST_INTERVAL_MS,
          demand.signal,
          { retryTransientErrors: false },
        );
      },
    );
  });

  return { attach$, enabled$, thinkingText$, thinkingId$ };
}
