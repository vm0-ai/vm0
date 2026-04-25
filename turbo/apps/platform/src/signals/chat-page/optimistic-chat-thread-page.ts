import { command } from "ccstate";
import { createElement } from "react";
import { animationFrame } from "signal-timers";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { setChatAgentId$ } from "../agent-chat.ts";
import { pushState } from "../location.ts";
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

const renderChatThreadPage$ = command(({ set }, thread: ChatThreadSignals) => {
  set(updatePage$, createElement(ZeroChatThreadPage, { thread }), "sidebar");
});

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

    set(renderChatThreadPage$, result.pendingThread);
    pushState({}, "", `/chats/${result.threadId}`);

    return result;
  },
);

export const settleThreadSignals$ = command(
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

    set(renderChatThreadPage$, realThread);
    await set(activateNewChatThreadPageLoops$, realThread, threadId, signal);
  },
);
