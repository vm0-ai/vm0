import { command } from "ccstate";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import { detachedNavigateTo$ } from "../route.ts";
import type { ChatThreadSignals } from "./create-chat-thread.ts";
import { sidebarChatThreads$ } from "./optimistic-chat-thread-page.ts";

export const navigateToAdjacentThread$ = command(
  async (
    { get, set },
    args: {
      currentThreadId: string;
      direction: "prev" | "next";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const leftThreadId = get(currentLeftThread$)?.threadId ?? null;
    const rightThreadId = get(currentRightThread$)?.threadId ?? null;
    const inMainPane = args.currentThreadId === leftThreadId;
    const inSidebarPane = args.currentThreadId === rightThreadId;
    if (!inMainPane && !inSidebarPane) {
      return;
    }

    // Use the merged sidebar list (persisted + optimistic, deduped/sorted) so
    // mod+shift+arrow navigation works on a freshly-created optimistic thread
    // before the server's `threadListChanged` reload pulls it into
    // `chatThreads$`.
    const threads = await get(sidebarChatThreads$);
    signal.throwIfAborted();
    const excludedThreadId = inMainPane ? rightThreadId : leftThreadId;
    const availableThreads = threads.filter((thread) => {
      return thread.id !== excludedThreadId;
    });
    const idx = availableThreads.findIndex((t) => {
      return t.id === args.currentThreadId;
    });
    if (idx === -1) {
      return;
    }
    if (args.direction === "prev" && idx === 0) {
      // Escape upwards from the first thread to the agent chat page.
      if (inSidebarPane) {
        return;
      }
      const agentId = availableThreads[0]!.agent.id;
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId },
      });
      return;
    }
    const targetIdx = args.direction === "prev" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= availableThreads.length) {
      return;
    }
    const targetThreadId = availableThreads[targetIdx]!.id;
    if (inMainPane) {
      await set(loadLeftThread$, targetThreadId, signal);
    } else {
      await set(loadRightThread$, targetThreadId, signal);
    }
  },
);

export const scrollCurrentThread$ = command(
  ({ set }, thread: ChatThreadSignals, position: "top" | "bottom") => {
    if (position === "top") {
      set(thread.scrollToTop$);
    } else {
      set(thread.scrollToBottom$);
    }
  },
);
