import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { ZeroChatThreadPage } from "../../views/zero-page/zero-chat-thread-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { chatThreads$ } from "./chat-message.ts";
import { setChatAgentId$, currentChatThreadId$ } from "../agent-chat.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  currentChatThreadSignals$,
  ensureDraft$,
} from "./create-chat-thread.ts";
import { createRestoredAttachment } from "../zero-page/chat-draft.ts";

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
      createElement(
        SidebarLayout,
        null,
        createElement(ZeroChatThreadPage, { key: threadId }),
      ),
    );
    set(updateDocumentTitle$, "Chat");

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const sessions = await get(chatThreads$);
    signal.throwIfAborted();
    const session = sessions.find((s: { id: string }) => {
      return s.id === threadId;
    });
    const sessionTitle = session?.title ?? "New chat";
    set(updateDocumentTitle$, sessionTitle);

    const thread = get(currentChatThreadSignals$)!;
    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    set(setChatAgentId$, threadData?.agentId ?? null);

    // Seed draft from server data on first visit (local cache was empty).
    // Local-first: if the user already has local state, we do NOT overwrite it.
    if (
      isNew &&
      threadData !== null &&
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
    set(thread.scrollToBottom$);

    await set(thread.loadPagedMessages$, signal);
  },
);
