import { command, computed, state } from "ccstate";
import {
  currentChatAgentId$,
  currentChatThreadId$,
  setChatAgentId$,
} from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { idbMessageEnabled$ } from "../external/feature-switch.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  detachedNavigateTo$,
  pushPathSilently$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { resetSignal } from "../utils.ts";
import { createRestoredAttachment } from "../zero-page/chat-draft.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "./create-chat-thread.ts";
import { createIdbCachedDataSource } from "./idb-cached-chat-thread-data-source.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import {
  clearMatchingOptimisticChatThread$,
  optimisticChatThread$,
  sidebarOptimisticChatThread$,
} from "./optimistic-chat-thread-page.ts";
import { setupChatThreadSignals$ } from "./setup-chat-thread-signals.ts";

export const SIDEBAR_PARAM = "sidebar";

const internalLeftThread$ = state<ChatThreadSignals | null>(null);
export const internalRightThread$ = state<ChatThreadSignals | null>(null);

export const currentLeftThread$ = computed((get): ChatThreadSignals | null => {
  return get(internalLeftThread$);
});

export const currentRightThread$ = computed((get): ChatThreadSignals | null => {
  return get(internalRightThread$);
});

const resetLeftSetupSignal$ = resetSignal();
const resetRightSetupSignal$ = resetSignal();

/**
 * Make the left (primary) chat pane show `threadId`. Idempotent — re-loading
 * the current left thread is a no-op. Updates the URL pathname silently so
 * subsequent route re-entries (browser back / link share) replay correctly.
 *
 * If the requested thread is currently the right pane, the right pane is
 * unloaded first (a thread cannot occupy both panes).
 */
export const loadLeftThread$ = command(
  async (
    { get, set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const existing = get(internalLeftThread$);
    if (existing?.threadId === threadId) {
      return;
    }

    const currentRight = get(internalRightThread$);
    if (currentRight?.threadId === threadId) {
      set(unloadRightThread$);
    }

    if (get(currentChatThreadId$) !== threadId) {
      set(pushPathSilently$, "/chats/:threadId", { threadId });
    }

    const signal = set(resetLeftSetupSignal$, parentSignal);

    const optimisticThread = get(optimisticChatThread$);
    const matchingOptimistic =
      optimisticThread?.threadId === threadId ? optimisticThread : null;

    const { draft, isNew } = set(ensureDraft$, threadId);
    const idbEnabled = await get(idbMessageEnabled$);
    signal.throwIfAborted();
    const dataSource = idbEnabled
      ? createIdbCachedDataSource(threadId)
      : createRemoteChatThreadDataSource(threadId);
    const thread = createChatThreadSignals(threadId, draft, dataSource);

    // Publish: optimistic thread renders immediately while we wait for the
    // server confirmation; the real thread takes over after the swap below.
    set(internalLeftThread$, matchingOptimistic?.pendingThread ?? thread);

    set(updateDocumentTitle$, matchingOptimistic ? "New chat" : "Chat");

    if (matchingOptimistic) {
      await matchingOptimistic.settleResult;
      signal.throwIfAborted();
    }

    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    if (!threadData) {
      if (matchingOptimistic) {
        set(clearMatchingOptimisticChatThread$, matchingOptimistic);
      }
      set(internalLeftThread$, null);
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId !== threadData.agentId) {
      set(setChatAgentId$, threadData.agentId);
    }

    set(updateDocumentTitle$, threadData.title ?? "New chat");

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

    if (matchingOptimistic) {
      set(thread.hideSkeleton$);
      set(internalLeftThread$, thread);
      set(clearMatchingOptimisticChatThread$, matchingOptimistic);
    }

    const onThreadUpdated$ = command(async ({ get, set }, sig: AbortSignal) => {
      const data = await get(thread.threadData$);
      sig.throwIfAborted();
      if (data) {
        set(updateDocumentTitle$, data.title ?? "New chat");
      }
      return false;
    });

    await Promise.all([
      set(setupChatThreadSignals$, thread, signal),
      set(
        setAblyLoop$,
        `chatThreadRunUpdated:${threadId}`,
        onThreadUpdated$,
        signal,
      ),
    ]);
  },
);

/**
 * Make the right (sidebar) chat pane show `threadId`. Idempotent — re-loading
 * the current right thread is a no-op. Refuses to load the same thread that's
 * already in the left pane.
 */
export const loadRightThread$ = command(
  async (
    { get, set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const currentLeft = get(internalLeftThread$);
    if (currentLeft?.threadId === threadId) {
      return;
    }

    const existing = get(internalRightThread$);
    if (existing?.threadId === threadId) {
      return;
    }

    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) !== threadId) {
      next.set(SIDEBAR_PARAM, threadId);
      set(updateSearchParams$, next);
    }

    const signal = set(resetRightSetupSignal$, parentSignal);

    const optimisticThread = get(sidebarOptimisticChatThread$);
    if (optimisticThread?.threadId === threadId) {
      set(internalRightThread$, optimisticThread.pendingThread);
      return;
    }

    const { draft } = set(ensureDraft$, threadId);
    const idbEnabled = await get(idbMessageEnabled$);
    signal.throwIfAborted();
    const dataSource = idbEnabled
      ? createIdbCachedDataSource(threadId)
      : createRemoteChatThreadDataSource(threadId);
    const thread = createChatThreadSignals(threadId, draft, dataSource);
    set(internalRightThread$, thread);

    await set(setupChatThreadSignals$, thread, signal);
  },
);

export const unloadRightThread$ = command(({ get, set }) => {
  set(resetRightSetupSignal$);
  set(internalRightThread$, null);
  const next = new URLSearchParams(get(searchParams$));
  if (next.has(SIDEBAR_PARAM)) {
    next.delete(SIDEBAR_PARAM);
    set(updateSearchParams$, next);
  }
});
