import { command, computed, state } from "ccstate";
import { subscribeRealtimeReadyCatchUp$ } from "./realtime.ts";
import { clearOptimisticReadMark$ } from "./chat-page/optimistic-chat-thread-read-marks.ts";

const internalReloadChatIndicators$ = state(0);

export const reloadChatIndicatorsCounter$ = computed((get) => {
  return get(internalReloadChatIndicators$);
});

export const reloadChatIndicators$ = command(({ set }) => {
  set(internalReloadChatIndicators$, (n) => {
    return n + 1;
  });
});

export const invalidateChatIndicatorsFromRealtime$ = command(
  ({ set }, payload: unknown) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "threadId" in payload &&
      typeof payload.threadId === "string" &&
      "lastReadAt" in payload &&
      payload.lastReadAt === null
    ) {
      set(clearOptimisticReadMark$, payload.threadId);
    }
    set(reloadChatIndicators$);
  },
);

const reloadChatIndicatorsOnForeground$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reloadChatIndicators$);
  },
);

export const setupChatIndicatorForegroundCatchUp$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      subscribeRealtimeReadyCatchUp$,
      reloadChatIndicatorsOnForeground$,
      signal,
    );
  },
);
