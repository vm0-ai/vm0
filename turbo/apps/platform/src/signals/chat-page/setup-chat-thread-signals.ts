import { command } from "ccstate";
import { animationFrame } from "signal-timers";
import type { ChatThreadSignals } from "./create-chat-thread.ts";

/**
 * Bootstrap a thread's signals after construction:
 *   - resolve thread metadata (early-exit if missing)
 *   - await the first page of messages
 *   - schedule scroll-to-bottom + skeleton hide on the next animation frame
 *   - start runPhraseLoop
 *
 * loadPagedMessages$ (mark-read + Ably + IDB catch-up) is fired earlier from
 * resolvePaneThread$ so it races chat-threads/:id; the caller awaits that
 * promise alongside this command.
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

    // loadPagedMessages$ is started earlier from resolvePaneThread$ so the
    // IDB catch-up races chat-threads/:id. The caller awaits that promise.
    await set(thread.runPhraseLoop$, signal);
  },
);
