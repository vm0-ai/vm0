import { command } from "ccstate";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";

export const setupChatThreadInitScroll$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    set(thread.requestScrollAfterRender$, get(thread.threadScrollPosition$));
    await get(thread.visibleRenderedChatGroupsReady$);
    signal.throwIfAborted();
  },
);
