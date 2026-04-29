import { command } from "ccstate";
import { chatThreads$, currentChatThreadId$ } from "../agent-chat.ts";
import {
  chatSidebarThreadId$,
  navigateMainChatPreservingSidebar$,
  openChatSidebar$,
} from "./chat-sidebar.ts";
import { detachedNavigateTo$ } from "../route.ts";
import type { ChatThreadSignals } from "./create-chat-thread.ts";

export const navigateToAdjacentThread$ = command(
  async (
    { get, set },
    args: {
      currentThreadId: string;
      direction: "prev" | "next";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const mainThreadId = get(currentChatThreadId$);
    const sidebarThreadId = get(chatSidebarThreadId$);
    const inMainPane = args.currentThreadId === mainThreadId;
    const inSidebarPane = args.currentThreadId === sidebarThreadId;
    if (!inMainPane && !inSidebarPane) {
      return;
    }

    const threads = await get(chatThreads$);
    signal.throwIfAborted();
    const excludedThreadId = inMainPane ? sidebarThreadId : mainThreadId;
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
      set(navigateMainChatPreservingSidebar$, targetThreadId);
    } else {
      set(openChatSidebar$, targetThreadId);
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
