import { command } from "ccstate";
import { animationFrame } from "signal-timers";
import type { ChatThreadSignals } from "./create-chat-thread.ts";

export const setupChatThreadInitScroll$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    await get(thread.groupedChatMessages$);
    signal.throwIfAborted();

    animationFrame(
      () => {
        set(thread.scrollToBottom$);
        set(thread.hideSkeleton$);
      },
      { signal },
    );
  },
);
