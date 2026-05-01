import { command } from "ccstate";
import { animationFrame } from "signal-timers";
import type { ChatThreadSignals } from "./create-chat-thread.ts";

/**
 * Bootstrap a thread's signals after construction:
 *   - resolve thread metadata (early-exit if missing)
 *   - load the first page of messages
 *   - schedule scroll-to-bottom + skeleton hide on the next animation frame
 *   - start runPhraseLoop + loadPagedMessages
 *
 * Called from setupChatPage$ for the primary thread and from
 * openOrSwitchSidebarThread$ for the sidebar thread, so both surfaces share
 * the same lifecycle without depending on DOM ref attachment.
 */
export const setupChatThreadSignals$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    if (!threadData) {
      set(thread.hideSkeleton$);
      return;
    }

    await get(thread.groupedChatMessages$);
    signal.throwIfAborted();

    animationFrame(
      () => {
        set(thread.scrollToBottom$);
        set(thread.hideSkeleton$);
      },
      { signal },
    );

    await Promise.all([
      set(thread.runPhraseLoop$, signal),
      set(thread.loadPagedMessages$, signal),
    ]);
  },
);
