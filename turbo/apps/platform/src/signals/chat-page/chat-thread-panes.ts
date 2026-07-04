import { command, computed, state, type Command } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { logger } from "../log.ts";
import {
  pushPathSilently$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { resetSignal } from "../utils.ts";
import { createRestoredAttachment } from "../zero-page/chat-draft.ts";
import { clearArtifactPreview$ } from "../zero-page/zero-artifact-sidebar.ts";
import { setChatThreadVirtualScrollTarget$ } from "../zero-page/zero-sidebar-state.ts";
import { createChatThreadSignals, ensureDraft$ } from "./create-chat-thread.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import { closeHeaderAutomationSidebar$ } from "./header-automation-sidebar.ts";
import { createIdbCachedDataSource } from "./idb-cached-chat-thread-data-source.ts";
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
  const currentRightThread = get(internalRightThread$);
  if (currentRightThread) {
    set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
  }
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
      return;
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
    { set },
    args: {
      thread: ChatThreadSignals;
      isNew: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { thread, isNew } = args;

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
    { set },
    spec: PaneSpec,
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(spec.resetSetupSignal$, parentSignal);

    L.debug("setupPaneThread$ start", { threadId });

    const { draft, isNew } = set(ensureDraft$, threadId);
    let onIdbMiss: () => void = () => {};
    const dataSource = createIdbCachedDataSource(threadId, () => {
      onIdbMiss();
    });
    const thread = createChatThreadSignals(threadId, draft, dataSource);
    onIdbMiss = () => {
      set(thread.showSkeleton$);
    };
    set(spec.setPaneThread$, thread);
    set(setChatThreadVirtualScrollTarget$, threadId);

    await set(
      resolvePaneThread$,
      {
        thread,
        isNew,
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

    const currentLeftThread = get(internalLeftThread$);
    if (currentLeftThread && currentLeftThread.threadId !== threadId) {
      set(currentLeftThread.resetRenderedChatGroupsIfAtBottom$);
    }

    if (get(currentChatThreadId$) !== threadId) {
      // Drop right sidebar state before switching threads — open artifact
      // and automation panels are anchored to the previous thread's messages.
      set(clearArtifactPreview$);
      set(closeHeaderAutomationSidebar$);
      set(pushPathSilently$, "/chats/:threadId", { threadId });
    }

    await Promise.all([
      set(syncPrimaryThread$, threadId, parentSignal),
      set(
        setupPaneThread$,
        {
          setPaneThread$: setLeftThread$,
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

    const currentRightThread = get(internalRightThread$);
    if (currentRightThread && currentRightThread.threadId !== threadId) {
      set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
    }

    set(clearArtifactPreview$);
    set(closeHeaderAutomationSidebar$);

    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) !== threadId) {
      next.set(SIDEBAR_PARAM, threadId);
      set(updateSearchParams$, next);
    }

    await set(
      setupPaneThread$,
      {
        setPaneThread$: setRightThread$,
        resetSetupSignal$: resetRightSetupSignal$,
      },
      threadId,
      parentSignal,
    );
  },
);
