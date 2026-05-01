import { command, computed, state } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { idbMessageEnabled$ } from "../external/feature-switch.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { resetSignal } from "../utils.ts";
import {
  createChatThreadSignals,
  type ChatThreadSignals,
} from "./create-chat-thread.ts";
import { createIdbCachedDataSource } from "./idb-cached-chat-thread-data-source.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import { sidebarOptimisticChatThread$ } from "./optimistic-chat-thread-page.ts";
import { setupChatThreadSignals$ } from "./setup-chat-thread-signals.ts";
import { createDraftSignals } from "../zero-page/chat-draft.ts";

const SIDEBAR_PARAM = "sidebar";

const resetSidebarSetupSignal$ = resetSignal();

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

const internalSidebarThread$ = state<ChatThreadSignals | null>(null);

export const chatSidebarThread$ = computed((get): ChatThreadSignals | null => {
  const sidebarThreadId = get(chatSidebarThreadId$);
  if (!sidebarThreadId) {
    return null;
  }

  const optimisticThread = get(sidebarOptimisticChatThread$);
  if (optimisticThread?.threadId === sidebarThreadId) {
    return optimisticThread.pendingThread;
  }

  const inner = get(internalSidebarThread$);
  if (inner?.threadId !== sidebarThreadId) {
    // openOrSwitchSidebarThread$ has not yet populated state for this URL —
    // most commonly during the brief window before its data source resolves.
    return null;
  }
  return inner;
});

export const openOrSwitchSidebarThread$ = command(
  async (
    { get, set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const currentMainThreadId = get(currentChatThreadId$);
    if (!currentMainThreadId || threadId === currentMainThreadId) {
      return;
    }

    const currentSidebarThreadId = get(chatSidebarThreadId$);
    if (threadId === currentSidebarThreadId) {
      // Same thread re-clicked → toggle close.
      set(closeChatSidebar$);
      return;
    }

    if (currentSidebarThreadId !== threadId) {
      const next = new URLSearchParams(get(searchParams$));
      next.set(SIDEBAR_PARAM, threadId);
      set(updateSearchParams$, next);
    }

    const optimisticThread = get(sidebarOptimisticChatThread$);
    if (optimisticThread?.threadId === threadId) {
      // Optimistic thread carries its own setup; chatSidebarThread$ surfaces
      // it directly without our state.
      return;
    }

    const signal = set(resetSidebarSetupSignal$, parentSignal);
    const idbEnabled = await get(idbMessageEnabled$);
    signal.throwIfAborted();
    const dataSource = idbEnabled
      ? createIdbCachedDataSource(threadId)
      : createRemoteChatThreadDataSource(threadId);
    const thread = createChatThreadSignals(
      threadId,
      createDraftSignals(),
      dataSource,
    );
    set(internalSidebarThread$, thread);

    await set(setupChatThreadSignals$, thread, signal);
  },
);

const closeChatSidebar$ = command(({ get, set }) => {
  set(resetSidebarSetupSignal$);
  set(internalSidebarThread$, null);
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
