import { command, type Command } from "ccstate";
import type {
  ChatThreadDraft,
  PersistedAttachment,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { activeRoute$ } from "../active-route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { logger } from "../log.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { resetSignal } from "../utils.ts";
import { createRestoredAttachment } from "../okou-page/chat-draft.ts";
import {
  messageDocumentToEditorDoc,
  messageDocumentToPrompt,
} from "../okou-page/user-message-document-codec.ts";
import { createCachedChatPanelSignals$ } from "./create-chat-thread.ts";
import { createChatEventSignals } from "./chat-event-signals.ts";
import type { ChatPanelSignals } from "./chat-panel-signals.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import {
  type ChatThreadPaneState,
  currentLeftPane$,
  currentLeftThread$,
  currentRightPane$,
  currentRightThread$,
  setCurrentLeftPane$,
  setCurrentRightPane$,
} from "./chat-thread-pane-state.ts";
import {
  syncMissingPrimaryThread$,
  syncPrimaryThread$,
} from "./sync-primary-thread.ts";

export const SIDEBAR_PARAM = "sidebar";
export {
  currentLeftPane$,
  currentLeftThread$,
  currentRightPane$,
  currentRightThread$,
};

const L = logger("ChatPanes");

const resetLeftSetupSignal$ = resetSignal();
const resetRightSetupSignal$ = resetSignal();

// Thread-owned sidebars are anchored to the previous thread's messages.
const closeThreadSidebars$ = command(({ get, set }) => {
  for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
    if (thread) {
      set(thread.sidebar.close$);
    }
  }
});

export const unloadRightThread$ = command(({ get, set }) => {
  const currentRightThread = get(currentRightThread$);
  if (currentRightThread) {
    set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
    set(currentRightThread.sidebar.close$);
  }
  set(resetRightSetupSignal$);
  set(setCurrentRightPane$, null);
  const next = new URLSearchParams(get(searchParams$));
  if (next.has(SIDEBAR_PARAM)) {
    next.delete(SIDEBAR_PARAM);
    set(updateSearchParams$, next);
  }
});

interface PaneSpec {
  setPane$: Command<void, [ChatThreadPaneState]>;
  resetSetupSignal$: ReturnType<typeof resetSignal>;
  onNotFoundReady$?: Command<void, [AbortSignal]>;
}

interface RestoredDraftState {
  readonly content: string;
  readonly userMessage: UserMessageDocument | null;
  readonly attachments: PersistedAttachment[];
}

function userMessageDraftAttachments(
  document: UserMessageDocument,
  attachments: readonly PersistedAttachment[],
): PersistedAttachment[] {
  const attachmentById = new Map(
    attachments.map((attachment) => {
      return [attachment.id, attachment] as const;
    }),
  );
  return document.parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const attachment = attachmentById.get(part.fileId);
    return attachment ? [attachment] : [];
  });
}

function userMessageDraftState(
  threadDraft: ChatThreadDraft,
): RestoredDraftState | null {
  const document = threadDraft.draftUserMessage;
  if (!document || messageDocumentToEditorDoc(document) === null) {
    return null;
  }
  const content = messageDocumentToPrompt(document);
  if (content === null) {
    return null;
  }
  return {
    content,
    userMessage: document,
    attachments: userMessageDraftAttachments(
      document,
      threadDraft.draftAttachments ?? [],
    ),
  };
}

const loadDraft$ = command(
  async (
    { get, set },
    thread: ChatPanelSignals,
    isNew: boolean,
    signal: AbortSignal,
  ) => {
    const threadDraft = await get(thread.threadDraft$);
    signal.throwIfAborted();

    if (!threadDraft) {
      return;
    }

    const restoredDraft = userMessageDraftState(threadDraft);
    if (!restoredDraft) {
      return;
    }
    const hasDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.userMessage !== null ||
      restoredDraft.attachments.length > 0;
    if (isNew && hasDraft) {
      const restoredAttachments = restoredDraft.attachments.map(
        createRestoredAttachment,
      );
      const removedUnavailableAttachments = await set(
        thread.composer.draft.seed$,
        {
          content: restoredDraft.content,
          userMessage: restoredDraft.userMessage,
          generationTemplate: undefined,
          attachments: restoredAttachments,
        },
        signal,
      );
      if (removedUnavailableAttachments) {
        await set(thread.composer.draft.save$, signal);
      }
    }
  },
);
const resolvePaneThread$ = command(
  async (
    { set },
    args: {
      thread: ChatPanelSignals;
      isNew: boolean;
      initialEventId: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { thread, isNew, initialEventId } = args;

    L.debug("resolvePaneThread$ Promise.all start", {
      threadId: thread.threadId,
    });
    await Promise.all([
      set(loadDraft$, thread, isNew, signal),
      set(thread.subscribeChatThread$, signal),
      initialEventId
        ? set(
            thread.scrollToEvent$,
            initialEventId,
            {
              behavior: "instant",
              viewportOffsetTop: 0,
              preloadPreviousRenderWindow: false,
            },
            signal,
          )
        : Promise.resolve(),
    ]);
    signal.throwIfAborted();
    L.debug("resolvePaneThread$ Promise.all done", {
      threadId: thread.threadId,
    });
  },
);

const beginPaneSetup$ = command(
  ({ get, set }, spec: PaneSpec, parentSignal: AbortSignal): AbortSignal => {
    const signal = set(spec.resetSetupSignal$, parentSignal);
    signal.addEventListener(
      "abort",
      () => {
        // A non-chat page must never inherit this pane on re-entry.
        // Chat-to-chat setup keeps the reference so the outer thread section
        // can preserve its established DOM identity until replacement.
        if (get(activeRoute$) !== "chat") {
          set(spec.setPane$, null);
        }
      },
      { once: true },
    );
    return signal;
  },
);

const setupPaneThread$ = command(
  async (
    { set },
    spec: PaneSpec,
    meta: ThreadMeta,
    initialEventId: string | null,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(beginPaneSetup$, spec, parentSignal);
    const threadId = meta.id;

    L.debug("setupPaneThread$ start", { threadId });
    const chatEvents = createChatEventSignals(threadId);
    const { thread, isNew } = set(
      createCachedChatPanelSignals$,
      chatEvents,
      meta.agentId,
      signal,
    );
    set(spec.setPane$, { kind: "thread", thread });

    await set(
      resolvePaneThread$,
      {
        thread,
        isNew,
        initialEventId,
      },
      signal,
    );
  },
);

const setupPaneNotFound$ = command(
  (
    { set },
    spec: PaneSpec,
    threadId: string,
    parentSignal: AbortSignal,
  ): void => {
    const signal = set(beginPaneSetup$, spec, parentSignal);
    set(spec.setPane$, { kind: "not-found", threadId });
    if (spec.onNotFoundReady$) {
      set(spec.onNotFoundReady$, signal);
    }
  },
);

export const setupLeftThread$ = command(
  async (
    { set },
    meta: ThreadMeta,
    initialEventId: string | null,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await Promise.all([
      set(syncPrimaryThread$, meta, parentSignal),
      set(
        setupPaneThread$,
        {
          setPane$: setCurrentLeftPane$,
          resetSetupSignal$: resetLeftSetupSignal$,
        },
        meta,
        initialEventId,
        parentSignal,
      ),
    ]);
  },
);

export const setupLeftThreadNotFound$ = command(
  async (
    { set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    set(syncMissingPrimaryThread$);
    await set(
      setupPaneNotFound$,
      {
        setPane$: setCurrentLeftPane$,
        resetSetupSignal$: resetLeftSetupSignal$,
        onNotFoundReady$: hideAppSkeleton$,
      },
      threadId,
      parentSignal,
    );
  },
);

export const setupRightThread$ = command(
  async (
    { set },
    meta: ThreadMeta,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await set(
      setupPaneThread$,
      {
        setPane$: setCurrentRightPane$,
        resetSetupSignal$: resetRightSetupSignal$,
      },
      meta,
      null,
      parentSignal,
    );
  },
);

export const setupRightThreadNotFound$ = command(
  async (
    { set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await set(
      setupPaneNotFound$,
      {
        setPane$: setCurrentRightPane$,
        resetSetupSignal$: resetRightSetupSignal$,
      },
      threadId,
      parentSignal,
    );
  },
);

export const loadLeftThread$ = command(
  ({ get, set }, threadId: string): void => {
    if (get(currentChatThreadId$) === threadId) {
      return;
    }

    // Drop sidebar state before switching threads because its content is
    // anchored to the previous thread's messages.
    set(closeThreadSidebars$);

    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) === threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
      searchParams: next,
    });
  },
);

export const loadRightThread$ = command(
  ({ get, set }, threadId: string): void => {
    const mainThreadId = get(currentChatThreadId$);
    if (!mainThreadId || mainThreadId === threadId) {
      return;
    }

    if (get(currentRightThread$)?.threadId === threadId) {
      return;
    }

    const currentRightThread = get(currentRightThread$);
    if (currentRightThread && currentRightThread.threadId !== threadId) {
      set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
    }

    set(closeThreadSidebars$);

    const next = new URLSearchParams(get(searchParams$));
    next.set(SIDEBAR_PARAM, threadId);
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: mainThreadId },
      searchParams: next,
    });
  },
);
