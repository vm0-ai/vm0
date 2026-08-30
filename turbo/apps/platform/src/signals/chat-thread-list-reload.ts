import { command, computed, state } from "ccstate";
import {
  setAblyLoop$,
  setAblyPayloadLoop$,
  subscribeRealtimeReadyCatchUp$,
} from "./realtime.ts";
import { clearOptimisticReadMark$ } from "./chat-page/optimistic-chat-thread-read-marks.ts";
import { invalidateTabIndicators$ } from "../shared-database/worker-context.ts";

const internalReloadChatIndicators$ = state(0);

export const reloadChatIndicatorsCounter$ = computed((get) => {
  return get(internalReloadChatIndicators$);
});

export const reloadChatIndicators$ = command(({ set }) => {
  set(internalReloadChatIndicators$, (n) => {
    return n + 1;
  });
});

const reloadChatIndicatorsFromRealtime$ = command(({ set }) => {
  set(reloadChatIndicators$);
  set(invalidateTabIndicators$);
  return false;
});

const reloadChatIndicatorsFromReadCursor$ = command(
  ({ set }, payload: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
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
    set(invalidateTabIndicators$);
    return false;
  },
);

const reloadChatIndicatorsOnForeground$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reloadChatIndicators$);
  },
);

export const subscribeThreadListChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyLoop$,
      {
        scope: "credential",
        topic: "threadListChanged",
        loopCommand$: reloadChatIndicatorsFromRealtime$,
        options: { runOnForegroundCatchUp: false },
      },
      signal,
    );
  },
);

export const subscribeChatThreadReadCursorUpdated$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyPayloadLoop$,
      {
        topic: "chatThreadReadCursorUpdated",
        loopCommand$: reloadChatIndicatorsFromReadCursor$,
        options: { runOnForegroundCatchUp: false },
      },
      signal,
    );
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
