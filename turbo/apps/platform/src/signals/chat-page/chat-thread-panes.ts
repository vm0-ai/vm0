import { command, computed, state, type Command, type Computed } from "ccstate";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { idbMessageEnabled$ } from "../external/feature-switch.ts";
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
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import {
  clearMatchingOptimisticChatThread$,
  optimisticChatThread$,
  sidebarOptimisticChatThread$,
  type PendingChatThread,
} from "./optimistic-chat-thread-state.ts";
import { setupChatThreadInitScroll$ } from "./setup-chat-thread-signals.ts";
import { syncPrimaryThread$ } from "./sync-primary-thread.ts";

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
 * Per-pane wiring. The shared body lives in `setupPaneThread$`; this spec
 * captures the bits that vary so the two `loadX$` commands stay parallel.
 *
 * Document-title / agent-context / Ably title-sync used to live here as
 * boolean flags, but they only ever flipped on for the left pane. They've
 * moved to `syncPrimaryThread$`, which `loadLeftThread$` runs alongside
 * `setupPaneThread$`.
 */
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
/**
 * Second half of pane thread setup — called after the threadData$ resolves.
 * Owns: draft seeding, message page warm-up, optimistic swap, and the inner
 * setup loops. Extracted to keep cyclomatic complexity under the lint cap.
 */
const resolvePaneThread$ = command(
  async (
    { set },
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
      await thread.groupedChatMessages$;
      signal.throwIfAborted();
      set(thread.hideSkeleton$);
      set(spec.setPaneThread$, thread);
      set(clearMatchingOptimisticChatThread$, matchingOptimistic);
    }

    await Promise.all([
      set(loadDraft$, thread, isNew, signal),
      set(setupChatThreadInitScroll$, thread, signal),
      set(thread.runPhraseLoop$, signal),
      set(thread.subscribeChatThread$, signal),
    ]);
  },
);

/**
 * Shared body for `loadLeftThread$` / `loadRightThread$`. Owns: data-source
 * selection, optimistic publish + settle dance, then delegates the second
 * half to `resolvePaneThread$`.
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

    const { draft, isNew } = set(ensureDraft$, threadId);
    const idbEnabled = await get(idbMessageEnabled$);
    signal.throwIfAborted();
    // Forward-reference so the data source can flip the skeleton on at the
    // moment it discovers a cache miss, before the network fetch starts.
    let onIdbMiss: () => void = () => {};
    const dataSource = idbEnabled
      ? createIdbCachedDataSource(threadId, () => {
          onIdbMiss();
        })
      : createRemoteChatThreadDataSource(threadId);
    const thread = createChatThreadSignals(threadId, draft, dataSource);
    onIdbMiss = () => {
      set(thread.showSkeleton$);
    };
    if (!idbEnabled) {
      // No local cache — every load goes to the network, so the skeleton is
      // unconditional.
      set(thread.showSkeleton$);
    }

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
 *
 * Runs `syncPrimaryThread$` in parallel with the pane wiring so the document
 * title / global agent context / Ably title loop start as soon as the
 * primary thread switches, independent of how long the messages page takes.
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
