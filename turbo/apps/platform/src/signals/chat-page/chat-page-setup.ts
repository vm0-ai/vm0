import { command } from "ccstate";
import { createElement } from "react";
import { animationFrame } from "signal-timers";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  currentChatAgentId$,
  setChatAgentId$,
  currentChatThreadId$,
} from "../agent-chat.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { createChatThreadSignals, ensureDraft$ } from "./create-chat-thread.ts";
import { createRestoredAttachment } from "../zero-page/chat-draft.ts";
import { setupChatPageKeyboard$ } from "./chat-keyboard.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  clearMatchingOptimisticChatThread$,
  optimisticChatThread$,
} from "./optimistic-chat-thread-page.ts";
import { markRouteSetupBegin$ } from "../../lib/posthog.ts";

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(markRouteSetupBegin$);
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }
    const initialSearchParams = new URLSearchParams(get(searchParams$));

    set(updateDocumentTitle$, "Chat");

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const { draft, isNew } = set(ensureDraft$, threadId);
    const thread = createChatThreadSignals(threadId, draft);
    set(setupChatPageKeyboard$, thread, signal);

    const optimisticThread = get(optimisticChatThread$);
    const matchingOptimisticThread =
      optimisticThread?.threadId === threadId ? optimisticThread : null;

    set(
      updatePage$,
      createElement(ZeroChatThreadPage, {
        key: threadId,
        thread: matchingOptimisticThread?.pendingThread ?? thread,
      }),
      "sidebar",
    );
    await set(hideAppSkeleton$, signal);

    if (matchingOptimisticThread) {
      set(updateDocumentTitle$, "New chat");
      await matchingOptimisticThread.settleResult;
      signal.throwIfAborted();
    }

    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    if (!threadData) {
      if (matchingOptimisticThread) {
        set(clearMatchingOptimisticChatThread$, matchingOptimisticThread);
      }

      set(detachedNavigateTo$, "/", {
        searchParams: initialSearchParams,
        replace: true,
      });

      return;
    }

    const currentChatAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentChatAgentId !== threadData.agentId) {
      set(setChatAgentId$, threadData.agentId);
    }

    const sessionTitle = threadData.title ?? "New chat";
    set(updateDocumentTitle$, sessionTitle);

    if (
      isNew &&
      (threadData.draftContent !== null ||
        (threadData.draftAttachments !== null &&
          threadData.draftAttachments.length > 0))
    ) {
      const restoredAttachments = (threadData.draftAttachments ?? []).map(
        createRestoredAttachment,
      );
      set(
        thread.draft.seed$,
        threadData.draftContent ?? "",
        restoredAttachments,
      );
    }

    await get(thread.groupedChatMessages$);
    signal.throwIfAborted();

    if (matchingOptimisticThread) {
      set(thread.hideSkeleton$);
      set(
        updatePage$,
        createElement(ZeroChatThreadPage, {
          key: threadId,
          thread,
        }),
        "sidebar",
      );
      set(clearMatchingOptimisticChatThread$, matchingOptimisticThread);
    }

    animationFrame(
      () => {
        set(thread.scrollToBottom$);
        set(thread.hideSkeleton$);
      },
      { signal },
    );

    const onThreadUpdated$ = command(async ({ get, set }, sig: AbortSignal) => {
      const data = await get(thread.threadData$);
      sig.throwIfAborted();
      if (data) {
        set(updateDocumentTitle$, data.title ?? "New chat");
      }
      return false;
    });

    await Promise.all([
      set(thread.runPhraseLoop$, signal),
      set(thread.loadPagedMessages$, signal),
      set(
        setAblyLoop$,
        `chatThreadRunUpdated:${threadId}`,
        onThreadUpdated$,
        signal,
      ),
    ]);
  },
);
