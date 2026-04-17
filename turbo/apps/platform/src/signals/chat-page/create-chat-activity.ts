import { command, computed, state, type Command, type Computed } from "ccstate";
import { createRunLoop } from "../zero-page/polling.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createDeferredPromise, resetSignal } from "../utils.ts";
import type { AgentEvent } from "../zero-page/log-types.ts";
import type { GroupedChatMessageGroup } from "./chat-message.ts";

export interface ChatActivitySignals {
  activeRunId$: Computed<string | null>;
  events$: Computed<Promise<AgentEvent[] | null>>;
  trackActivityLoop$: Command<Promise<void>, [AbortSignal]>;
}

interface RunTracker {
  runId: string;
  seq: number;
  runLoop: ReturnType<typeof createRunLoop>;
}

/**
 * Walk groups back-to-front for the newest assistant message that carries
 * both a runId and a sequenceNumber. That pair seeds the activity loop so
 * the telemetry fetch starts past what chat already persisted.
 */
function findTailRun(
  groups: readonly GroupedChatMessageGroup[],
): { runId: string; seq: number } | null {
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const group = groups[gi]!;
    for (let mi = group.messages.length - 1; mi >= 0; mi--) {
      const msg = group.messages[mi]!;
      if (msg.runId !== undefined && msg.sequenceNumber !== undefined) {
        return { runId: msg.runId, seq: msg.sequenceNumber };
      }
    }
  }
  return null;
}

export function createChatActivitySignals(
  threadId: string,
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>,
): ChatActivitySignals {
  const internalRunTracker$ = state<RunTracker | null>(null);

  // Aborts the previously spawned per-run follower child signal whenever the
  // tracker changes; also cascades abort from the outer tracker signal.
  const runLoopReset$ = resetSignal();

  // Reconciler: runs on every chatThreadMessageCreated Ably ping. Recomputes
  // the tail run from the grouped messages. If the run changed, swaps the
  // tracker state and resets the follower's child signal.
  const reconcileActivity$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const groups = await get(groupedChatMessages$);
      signal.throwIfAborted();
      const tail = findTailRun(groups);

      const current = get(internalRunTracker$);
      if (tail?.runId === current?.runId) {
        return false;
      }

      if (!tail) {
        set(internalRunTracker$, null);
      } else {
        const runLoop = createRunLoop(tail.runId, tail.seq);
        set(internalRunTracker$, { runId: tail.runId, seq: tail.seq, runLoop });
      }
      set(runLoopReset$);
      return false;
    },
  );

  // Follower: a long-lived sequential loop that spawns one runEventCreated
  // Ably subscription per run. When the reconciler resets the child signal
  // (because runId changed), the current subscription aborts and we pick up
  // the new tracker in the next iteration.
  const runEventFollower$ = command(
    async ({ get, set }, outerSignal: AbortSignal): Promise<void> => {
      while (!outerSignal.aborted) {
        const tracker = get(internalRunTracker$);
        const childSignal = set(runLoopReset$, outerSignal);

        if (!tracker) {
          const deferred = createDeferredPromise<void>(childSignal);
          // eslint-disable-next-line no-restricted-syntax -- park until reconciler aborts childSignal with a new tracker
          try {
            await deferred.promise;
          } catch (error) {
            if (outerSignal.aborted) {
              throw error;
            }
            // Child reset — the reconciler installed a new tracker; loop.
          }
          continue;
        }

        // eslint-disable-next-line no-restricted-syntax -- child Ably loop aborts on runId change; rethrow only if outer aborted, otherwise loop to next run
        try {
          await set(
            setAblyLoop$,
            `runEventCreated:${tracker.runId}`,
            tracker.runLoop.checkFinished$,
            childSignal,
          );
        } catch (error) {
          if (outerSignal.aborted) {
            throw error;
          }
          // Child reset — the reconciler installed a new tracker; loop.
        }
      }
    },
  );

  const trackActivityLoop$ = command(async ({ set }, signal: AbortSignal) => {
    await Promise.all([
      set(
        setAblyLoop$,
        `chatThreadMessageCreated:${threadId}`,
        reconcileActivity$,
        signal,
      ),
      set(runEventFollower$, signal),
    ]);
  });

  const activeRunId$ = computed((get) => {
    return get(internalRunTracker$)?.runId ?? null;
  });

  const events$ = computed(async (get): Promise<AgentEvent[] | null> => {
    const tracker = get(internalRunTracker$);
    if (!tracker) {
      return null;
    }
    const pages = await get(tracker.runLoop.pagedEventsList$);
    if (pages.length === 0) {
      return [];
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

  return { activeRunId$, events$, trackActivityLoop$ };
}
