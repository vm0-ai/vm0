import { command, computed, state } from "ccstate";
import {
  setAblyLoop$,
  setAblyPayloadLoop$,
  subscribeRealtimeReadyCatchUp$,
} from "./realtime.ts";
import { clearOptimisticReadMark$ } from "./chat-page/optimistic-chat-thread-read-marks.ts";
import { invalidateTabIndicators$ } from "../shared-database/worker-context.ts";
import { apiClientRuntime$ } from "./api-client-runtime.ts";
import { reloadSharedDatabaseIndicators$ } from "./shared-database-bridge-state.ts";

const internalReloadChatIndicators$ = state(0);

export const reloadChatIndicatorsCounter$ = computed((get) => {
  return get(internalReloadChatIndicators$);
});

export const reloadChatIndicatorsLocally$ = command(({ set }) => {
  set(internalReloadChatIndicators$, (n) => {
    return n + 1;
  });
});

export const reloadChatIndicators$ = command(({ get, set }) => {
  if (get(apiClientRuntime$).environment === "app") {
    set(reloadSharedDatabaseIndicators$);
  }
  set(reloadChatIndicatorsLocally$);
});

export const reloadChatIndicatorsFromRealtime$ = command(({ set }) => {
  set(reloadChatIndicators$);
  set(invalidateTabIndicators$, null);
  return false;
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
    set(reloadChatIndicatorsLocally$);
  },
);

const reloadChatIndicatorsFromReadCursor$ = command(
  ({ set }, payload: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(reloadChatIndicators$);
    set(invalidateTabIndicators$, payload);
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
        options: {
          runOnForegroundCatchUp: false,
          runOnSubscribe: true,
        },
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
        scope: "credential",
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
