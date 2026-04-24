import { command } from "ccstate";
import { createElement } from "react";
import { animationFrame } from "signal-timers";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { setChatAgentId$, currentChatThreadId$ } from "../agent-chat.ts";
import { defaultAgentId$ } from "../agent.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  currentChatThreadSignals$,
  ensureDraft$,
} from "./create-chat-thread.ts";
import { createRestoredAttachment } from "../zero-page/chat-draft.ts";
import { setupChatPageKeyboard$ } from "./chat-keyboard.ts";
import { setAblyLoop$ } from "../realtime.ts";

export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    // Provision draft before rendering so currentChatThreadSignals$ is
    // available on first render. `isNew` tells us whether the local cache
    // was empty — if so, we will seed draft signals from server data below.
    const { isNew } = set(ensureDraft$, threadId);

    set(
      updatePage$,
      createElement(ZeroChatThreadPage, { key: threadId }),
      "sidebar",
    );
    set(updateDocumentTitle$, "Chat");
    set(setupChatPageKeyboard$, signal);

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const thread = get(currentChatThreadSignals$)!;
    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    if (!threadData) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId) {
        throw new Error("Chat page requires a default agent, but none found");
      }
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }

    // Use threadData for title (reliable on page refresh) instead of chatThreads$
    const sessionTitle = threadData.title ?? "New chat";
    set(updateDocumentTitle$, sessionTitle);

    set(setChatAgentId$, threadData.agentId ?? null);

    // Seed draft from server data on first visit (local cache was empty).
    // Local-first: if the user already has local state, we do NOT overwrite it.
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

    // The list is mounted with visibility:hidden under the skeleton so
    // scrollHeight is already correct; wait one frame for React to commit
    // the message DOM, then scroll and reveal in the same tick.
    animationFrame(
      () => {
        set(thread.scrollToBottom$);
        set(thread.hideSkeleton$);
      },
      { signal },
    );

    // Reactive document title: update when thread data changes via Ably events
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
