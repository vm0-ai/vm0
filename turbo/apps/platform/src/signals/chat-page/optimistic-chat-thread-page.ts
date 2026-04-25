import { command, computed, state } from "ccstate";
import { createElement } from "react";
import { animationFrame } from "signal-timers";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { setChatAgentId$ } from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import {
  activateNewChatThreadPageLoops$,
  sendNewThreadMessage$,
  type SendNewThreadMessagePending,
  type SendNewThreadMessageRequest,
} from "./chat-message.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "./create-chat-thread.ts";

const internalOptimisticThreadSends$ = state(
  new Map<string, SendNewThreadMessagePending>(),
);

export const optimisticThreadSends$ = computed(
  (get): ReadonlyMap<string, SendNewThreadMessagePending> => {
    return get(internalOptimisticThreadSends$);
  },
);

const storeOptimisticThreadSend$ = command(
  ({ get, set }, pending: SendNewThreadMessagePending) => {
    const next = new Map(get(internalOptimisticThreadSends$));
    next.set(pending.threadId, pending);
    set(internalOptimisticThreadSends$, next);
  },
);

const clearOptimisticThreadSend$ = command(({ get, set }, threadId: string) => {
  const sends = get(internalOptimisticThreadSends$);
  if (!sends.has(threadId)) {
    return;
  }
  const next = new Map(sends);
  next.delete(threadId);
  set(internalOptimisticThreadSends$, next);
});

const renderChatThreadPage$ = command(
  ({ set }, threadId: string, thread: ChatThreadSignals) => {
    set(
      updatePage$,
      createElement(ZeroChatThreadPage, { key: threadId, thread }),
      "sidebar",
    );
  },
);

export const sendNewThreadOptimistically$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<SendNewThreadMessagePending | null> => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return null;
    }

    set(storeOptimisticThreadSend$, result);
    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: result.threadId },
    });

    return result;
  },
);

const settleThreadSignals$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const { draft: threadDraft } = set(ensureDraft$, threadId);
    const realThread = createChatThreadSignals(threadId, threadDraft);
    const threadData = await get(realThread.threadData$);
    signal.throwIfAborted();
    if (threadData?.agentId) {
      set(setChatAgentId$, threadData.agentId);
    }

    await get(realThread.groupedChatMessages$);
    signal.throwIfAborted();
    set(realThread.hideSkeleton$);
    animationFrame(
      () => {
        set(realThread.scrollToBottom$);
      },
      { signal },
    );
    signal.throwIfAborted();

    set(renderChatThreadPage$, threadId, realThread);
    await set(activateNewChatThreadPageLoops$, realThread, threadId, signal);
  },
);

export const setupOptimisticChatThreadPage$ = command(
  async (
    { set },
    pending: SendNewThreadMessagePending,
    signal: AbortSignal,
  ) => {
    set(setChatAgentId$, pending.agentId);
    set(updateDocumentTitle$, "New chat");
    set(renderChatThreadPage$, pending.threadId, pending.pendingThread);
    await set(hideAppSkeleton$, signal);

    await pending.sendResult;
    signal.throwIfAborted();
    set(clearOptimisticThreadSend$, pending.threadId);
    await set(settleThreadSignals$, pending.threadId, signal);
  },
);
