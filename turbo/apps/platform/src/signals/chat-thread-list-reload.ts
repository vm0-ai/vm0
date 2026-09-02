import { command, computed, state } from "ccstate";
import { clearOptimisticReadMark$ } from "./chat-page/optimistic-chat-thread-read-marks.ts";

const internalReloadChatIndicators$ = state(0);

export const reloadChatIndicatorsCounter$ = computed((get) => {
  return get(internalReloadChatIndicators$);
});

export const reloadChatIndicatorsLocally$ = command(({ set }) => {
  set(internalReloadChatIndicators$, (n) => {
    return n + 1;
  });
});

export const applyChatThreadReadCursorUpdated$ = command(
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
  },
);
