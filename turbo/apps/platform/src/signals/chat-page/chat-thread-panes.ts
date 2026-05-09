import { command, computed, state, type Command, type Computed } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { logger } from "../log.ts";
import {
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
import {
  clearMatchingOptimisticChatThread$,
  optimisticChatThread$,
  sidebarOptimisticChatThread$,
  type PendingChatThread,
} from "./optimistic-chat-thread-state.ts";
import { setupChatThreadInitScroll$ } from "./setup-chat-thread-signals.ts";
import { syncPrimaryThread$ } from "./sync-primary-thread.ts";

export const SIDEBAR_PARAM = "sidebar";

const L = logger("ChatPanes");

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

export const unloadRightThread$ = command(({ get, set }) => {
  set(resetRightSetupSignal$);
  set(internalRightThread$, null);
  const next = new URLSearchParams(get(searchParams$));
  if (next.has(SIDEBAR_PARAM)) {
    next.delete(SIDEBAR_PARAM);
    set(updateSearchParams$, next);
  }
});

interface PaneSpec {
  setPaneThread$: Command<void, [ChatThreadSignals | null]>;
  optimisticSource$: Computed<PendingChatThread | null>;
  resetSetupSignal$: ReturnType<typeof resetSignal>;
}

const loadDraft$ = command(
  async (
    { get, set },
    thread: ChatThreadSignals,
    isNew: boolean,
    signal: AbortSignal,
  ) => {
    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();

    if (!threadData) {
      throw new Error("Thread data missing");
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
  },
);
const resolvePaneThread$ = command(
  async (
    { get, set },
    args: {
      spec: PaneSpec;
      thread: ReturnType<typeof createChatThreadSignals>;
      isNew: boolean;
      matchingOptimistic: PendingChatThread | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { spec, thread, isNew, matchingOptimistic } = args;

    if (matchingOptimistic) {
      L.debug("resolvePaneThread$ swap start", { threadId: thread.threadId });
      await get(thread.groupedChatMessages$);
      signal.throwIfAborted();
      set(thread.hideSkeleton$);
      set(spec.setPaneThread$, thread);
      set(clearMatchingOptimisticChatThread$, matchingOptimistic);
      L.debug("resolvePaneThread$ swap done", {
        threadId: thread.threadId,
      });
    }

    L.debug("resolvePaneThread$ Promise.all start", {
      threadId: thread.threadId,
    });
    await Promise.all([
      set(loadDraft$, thread, isNew, signal),
      set(setupChatThreadInitScroll$, thread, signal),
      set(thread.runPhraseLoop$, signal),
      set(thread.subscribeChatThread$, signal),
    ]);
    signal.throwIfAborted();
    L.debug("resolvePaneThread$ Promise.all done", {
      threadId: thread.threadId,
    });
  },
);

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
    L.debug("setupPaneThread$ start", {
      threadId,
      hasOptimistic: Boolean(matchingOptimistic),
    });

    if (matchingOptimistic) {
      set(spec.setPaneThread$, matchingOptimistic.pendingThread);
    }

    const { draft, isNew } = set(ensureDraft$, threadId);
    let onIdbMiss: () => void = () => {};
    const dataSource = createIdbCachedDataSource(threadId, () => {
      onIdbMiss();
    });
    const thread = createChatThreadSignals(threadId, draft, dataSource);
    onIdbMiss = () => {
      if (matchingOptimistic) {
        return;
      }
      set(thread.showSkeleton$);
    };
    if (!matchingOptimistic) {
      set(spec.setPaneThread$, thread);
    }

    if (matchingOptimistic) {
      L.debug("setupPaneThread$ awaiting settleResult", { threadId });
      await matchingOptimistic.settleResult;
      L.debug("setupPaneThread$ settleResult resolved", { threadId });
      signal.throwIfAborted();
    }

    await set(
      resolvePaneThread$,
      {
        spec,
        thread,
        isNew,
        matchingOptimistic,
      },
      signal,
    );
  },
);

export const loadLeftThread$ = command(
  async (
    { get, set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    if (get(internalRightThread$)?.threadId === threadId) {
      set(unloadRightThread$);
    }

    if (get(currentChatThreadId$) !== threadId) {
      set(pushPathSilently$, "/chats/:threadId", { threadId });
    }

    await Promise.all([
      set(syncPrimaryThread$, threadId, parentSignal),
      set(
        setupPaneThread$,
        {
          setPaneThread$: setLeftThread$,
          optimisticSource$: optimisticChatThread$,
          resetSetupSignal$: resetLeftSetupSignal$,
        },
        threadId,
        parentSignal,
      ),
    ]);
  },
);

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
      },
      threadId,
      parentSignal,
    );
  },
);
