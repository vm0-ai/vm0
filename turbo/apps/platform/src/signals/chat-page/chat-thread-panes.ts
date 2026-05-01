import { command, computed, state, type Command, type Computed } from "ccstate";
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
  type PendingChatThread,
} from "./optimistic-chat-thread-state.ts";
import { setupChatThreadSignals$ } from "./setup-chat-thread-signals.ts";

export const SIDEBAR_PARAM = "sidebar";

const internalLeftThread$ = state<ChatThreadSignals | null>(null);
const internalRightThread$ = state<ChatThreadSignals | null>(null);

export const currentLeftThread$ = computed((get): ChatThreadSignals | null => {
  return get(internalLeftThread$);
});

export const currentRightThread$ = computed((get): ChatThreadSignals | null => {
  return get(internalRightThread$);
});

const setLeftThread$ = command(({ set }, thread: ChatThreadSignals | null) => {
  set(internalLeftThread$, thread);
});

const setRightThread$ = command(({ set }, thread: ChatThreadSignals | null) => {
  set(internalRightThread$, thread);
});

const resetLeftSetupSignal$ = resetSignal();
const resetRightSetupSignal$ = resetSignal();

const unloadLeftThreadGoHome$ = command(({ set }) => {
  set(internalLeftThread$, null);
  set(detachedNavigateTo$, "/", { replace: true });
});

export const unloadRightThread$ = command(({ get, set }) => {
  set(resetRightSetupSignal$);
  set(internalRightThread$, null);
  const next = new URLSearchParams(get(searchParams$));
  if (next.has(SIDEBAR_PARAM)) {
    next.delete(SIDEBAR_PARAM);
    set(updateSearchParams$, next);
  }
});

/**
 * Per-pane wiring + the side-effects that differ between left (primary) and
 * right (sidebar). The shared body lives in `setupPaneThread$`; this spec
 * captures everything that varies so the two `loadX$` commands stay parallel.
 */
interface PaneSpec {
  setPaneThread$: Command<void, [ChatThreadSignals | null]>;
  optimisticSource$: Computed<PendingChatThread | null>;
  resetSetupSignal$: ReturnType<typeof resetSignal>;
  /** Title to set when the pane first publishes; `null` to leave untouched. */
  initialDocumentTitle: ((isOptimistic: boolean) => string) | null;
  /** When the thread resolves: align the global agent context to it. */
  syncAgentContextOnResolved: boolean;
  /** When the thread resolves: push its title into the document title. */
  syncDocumentTitleFromThread: boolean;
  /** Subscribe to Ably run-updates to keep the document title in sync. */
  subscribeAblyTitleUpdates: boolean;
  /** Cleanup when threadData$ resolves to null (404). */
  onMissing$: Command<void, []>;
}

/**
 * Second half of pane thread setup — called after the threadData$ resolves.
 * Owns: draft seeding, message page warm-up, optimistic swap, and the inner
 * setup loops. Extracted to keep cyclomatic complexity under the lint cap.
 */
const resolvePaneThread$ = command(
  async (
    { get, set },
    args: {
      spec: PaneSpec;
      threadId: string;
      thread: ReturnType<typeof createChatThreadSignals>;
      isNew: boolean;
      matchingOptimistic: PendingChatThread | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { spec, threadId, thread, isNew, matchingOptimistic } = args;

    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    if (!threadData) {
      if (matchingOptimistic) {
        set(clearMatchingOptimisticChatThread$, matchingOptimistic);
      }
      set(spec.onMissing$);
      return;
    }

    if (spec.syncAgentContextOnResolved) {
      const currentAgentId = await get(currentChatAgentId$);
      signal.throwIfAborted();
      if (currentAgentId !== threadData.agentId) {
        set(setChatAgentId$, threadData.agentId);
      }
    }

    if (spec.syncDocumentTitleFromThread) {
      set(updateDocumentTitle$, threadData.title ?? "New chat");
    }

    const hasDraftContent = threadData.draftContent !== null;
    const draftAttachments = threadData.draftAttachments;
    const hasDraftAttachments =
      draftAttachments !== null && draftAttachments.length > 0;
    if (isNew && (hasDraftContent || hasDraftAttachments)) {
      const restoredAttachments = (draftAttachments ?? []).map(
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
      set(spec.setPaneThread$, thread);
      set(clearMatchingOptimisticChatThread$, matchingOptimistic);
    }

    const tasks: Promise<unknown>[] = [
      set(setupChatThreadSignals$, thread, signal),
    ];

    if (spec.subscribeAblyTitleUpdates) {
      const onThreadUpdated$ = command(
        async ({ get, set }, sig: AbortSignal) => {
          const data = await get(thread.threadData$);
          sig.throwIfAborted();
          if (data) {
            set(updateDocumentTitle$, data.title ?? "New chat");
          }
          return false;
        },
      );
      tasks.push(
        set(
          setAblyLoop$,
          `chatThreadRunUpdated:${threadId}`,
          onThreadUpdated$,
          signal,
        ),
      );
    }

    await Promise.all(tasks);
  },
);

/**
 * Shared body for `loadLeftThread$` / `loadRightThread$`. Owns: data-source
 * selection, optimistic publish + settle dance, then delegates the second
 * half to `resolvePaneThread$`.
 *
 * Per-pane variations are routed through `spec` so the two callers reduce to
 * tiny preambles that only express what's actually different (URL shape,
 * conflict policy with the opposite pane).
 */
const setupPaneThread$ = command(
  async (
    { get, set },
    spec: PaneSpec,
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(spec.resetSetupSignal$, parentSignal);

    const optimisticThread = get(spec.optimisticSource$);
    const matchingOptimistic =
      optimisticThread?.threadId === threadId ? optimisticThread : null;

    if (matchingOptimistic) {
      set(spec.setPaneThread$, matchingOptimistic.pendingThread);
    }
    if (spec.initialDocumentTitle) {
      set(
        updateDocumentTitle$,
        spec.initialDocumentTitle(matchingOptimistic !== null),
      );
    }

    const { draft, isNew } = set(ensureDraft$, threadId);
    const idbEnabled = await get(idbMessageEnabled$);
    signal.throwIfAborted();
    const dataSource = idbEnabled
      ? createIdbCachedDataSource(threadId)
      : createRemoteChatThreadDataSource(threadId);
    const thread = createChatThreadSignals(threadId, draft, dataSource);

    if (!matchingOptimistic) {
      set(spec.setPaneThread$, thread);
    }

    if (matchingOptimistic) {
      await matchingOptimistic.settleResult;
      signal.throwIfAborted();
    }

    await set(
      resolvePaneThread$,
      {
        spec,
        threadId,
        thread,
        isNew,
        matchingOptimistic,
      },
      signal,
    );
  },
);

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
    if (get(internalLeftThread$)?.threadId === threadId) {
      return;
    }

    if (get(internalRightThread$)?.threadId === threadId) {
      set(unloadRightThread$);
    }

    if (get(currentChatThreadId$) !== threadId) {
      set(pushPathSilently$, "/chats/:threadId", { threadId });
    }

    await set(
      setupPaneThread$,
      {
        setPaneThread$: setLeftThread$,
        optimisticSource$: optimisticChatThread$,
        resetSetupSignal$: resetLeftSetupSignal$,
        initialDocumentTitle: (isOptimistic) => {
          return isOptimistic ? "New chat" : "Chat";
        },
        syncAgentContextOnResolved: true,
        syncDocumentTitleFromThread: true,
        subscribeAblyTitleUpdates: true,
        onMissing$: unloadLeftThreadGoHome$,
      },
      threadId,
      parentSignal,
    );
  },
);

/**
 * Make the right (sidebar) chat pane show `threadId`. Idempotent — re-loading
 * the current right thread is a no-op. Refuses to load the same thread that's
 * already in the left pane.
 *
 * Mirrors `loadLeftThread$` except: this pane does not own the document
 * title, the global agent context, or the Ably title-sync subscription.
 */
export const loadRightThread$ = command(
  async (
    { get, set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    if (get(internalLeftThread$)?.threadId === threadId) {
      return;
    }

    if (get(internalRightThread$)?.threadId === threadId) {
      return;
    }

    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) !== threadId) {
      next.set(SIDEBAR_PARAM, threadId);
      set(updateSearchParams$, next);
    }

    await set(
      setupPaneThread$,
      {
        setPaneThread$: setRightThread$,
        optimisticSource$: sidebarOptimisticChatThread$,
        resetSetupSignal$: resetRightSetupSignal$,
        initialDocumentTitle: null,
        syncAgentContextOnResolved: false,
        syncDocumentTitleFromThread: false,
        subscribeAblyTitleUpdates: false,
        onMissing$: unloadRightThread$,
      },
      threadId,
      parentSignal,
    );
  },
);
