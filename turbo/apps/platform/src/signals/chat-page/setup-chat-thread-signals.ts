import { command } from "ccstate";
import { animationFrame } from "signal-timers";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";

export const setupChatThreadInitScroll$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    await get(thread.visibleRenderedChatGroupsReady$);
    signal.throwIfAborted();

    animationFrame(
      () => {
        set(thread.scrollToBottom$);
      },
      { signal },
    );
  },
);
