import { command, computed } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import {
  createChatThreadSignals,
  type ChatThreadSignals,
} from "./create-chat-thread.ts";
import { createDraftSignals } from "../zero-page/chat-draft.ts";

const SIDEBAR_PARAM = "sidebar";

export const chatSidebarThreadId$ = computed((get): string | null => {
  const currentThreadId = get(currentChatThreadId$);
  if (!currentThreadId) {
    return null;
  }

  const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
  if (!sidebarThreadId || sidebarThreadId === currentThreadId) {
    return null;
  }

  return sidebarThreadId;
});

export const chatSidebarThread$ = computed((get): ChatThreadSignals | null => {
  const sidebarThreadId = get(chatSidebarThreadId$);
  if (!sidebarThreadId) {
    return null;
  }

  return createChatThreadSignals(sidebarThreadId, createDraftSignals());
});

export const openChatSidebar$ = command(({ get, set }, threadId: string) => {
  const currentThreadId = get(currentChatThreadId$);
  const currentSidebarThreadId = get(chatSidebarThreadId$);
  if (!currentThreadId) {
    return;
  }
  if (threadId === currentThreadId) {
    return;
  }
  if (threadId === currentSidebarThreadId) {
    set(closeChatSidebar$);
    return;
  }

  const next = new URLSearchParams(get(searchParams$));
  next.set(SIDEBAR_PARAM, threadId);
  set(updateSearchParams$, next);
});

const closeChatSidebar$ = command(({ get, set }) => {
  const next = new URLSearchParams(get(searchParams$));
  next.delete(SIDEBAR_PARAM);
  set(updateSearchParams$, next);
});

export const navigateMainChatPreservingSidebar$ = command(
  ({ get, set }, threadId: string) => {
    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) === threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId },
      searchParams: next,
    });
  },
);
