import { command, computed, type Command } from "ccstate";
import type {
  ChatThreadDraft,
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { resetSignal } from "../utils.ts";
import { createRestoredAttachment } from "../zero-page/chat-draft.ts";
import {
  messageDocumentToEditorDoc,
  messageDocumentToPrompt,
} from "../zero-page/user-message-document-codec.ts";
import { createChatThreadSignals, ensureDraft$ } from "./create-chat-thread.ts";
import { createOptimisticChatMessagesForThread } from "./optimistic-chat-messages.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
  setCurrentLeftThread$,
  setCurrentRightThread$,
} from "./chat-thread-pane-state.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import { setupChatThreadInitScroll$ } from "./setup-chat-thread-signals.ts";
import { syncPrimaryThread$ } from "./sync-primary-thread.ts";
import { autoOpenThreadSidebar$ } from "./thread-sidebar-coordinator.ts";
import {
  createComposerConnectorAuthorizationSignals,
  type ComposerConnectorAuthorizationSignals,
} from "../zero-page/zero-connectors.ts";

export const SIDEBAR_PARAM = "sidebar";
export { currentLeftThread$, currentRightThread$ };

const L = logger("ChatPanes");

const leftPaneAgentId$ = computed((get): string | null => {
  const thread = get(currentLeftThread$);
  return thread ? get(thread.agentId$) : null;
});
const rightPaneAgentId$ = computed((get): string | null => {
  const thread = get(currentRightThread$);
  return thread ? get(thread.agentId$) : null;
});
const leftPaneConnectorAuthorization =
  createComposerConnectorAuthorizationSignals(leftPaneAgentId$);
const rightPaneConnectorAuthorization =
  createComposerConnectorAuthorizationSignals(rightPaneAgentId$);

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
  set(setCurrentRightThread$, null);
  const next = new URLSearchParams(get(searchParams$));
  if (next.has(SIDEBAR_PARAM)) {
    next.delete(SIDEBAR_PARAM);
    set(updateSearchParams$, next);
  }
});

interface PaneSpec {
  setPaneThread$: Command<void, [ChatThreadSignals | null]>;
  resetSetupSignal$: ReturnType<typeof resetSignal>;
  connectorAuthorization: ComposerConnectorAuthorizationSignals;
}

interface RestoredDraftState {
  readonly content: string;
  readonly userMessage: UserMessageDocument | null;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
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
  inlineTemplatesEnabled: boolean,
): RestoredDraftState | null {
  const document = threadDraft.draftUserMessage;
  if (
    !document ||
    messageDocumentToEditorDoc(document, {
      inlineTemplates: inlineTemplatesEnabled,
    }) === null
  ) {
    return null;
  }
  const content = messageDocumentToPrompt(document, {
    inlineTemplates: inlineTemplatesEnabled,
  });
  if (content === null) {
    return null;
  }
  const generationTemplate = document.parts.find((part) => {
    return part.type === "template";
  });
  return {
    content,
    userMessage: document,
    generationTemplate:
      !inlineTemplatesEnabled && generationTemplate?.type === "template"
        ? generationTemplate.template
        : undefined,
    attachments: userMessageDraftAttachments(
      document,
      threadDraft.draftAttachments ?? [],
    ),
  };
}

const loadDraft$ = command(
  async (
    { get, set },
    thread: ChatThreadSignals,
    isNew: boolean,
    signal: AbortSignal,
  ) => {
    const threadDraft = await get(thread.threadDraft$);
    signal.throwIfAborted();

    if (!threadDraft) {
      return;
    }

    const features = get(featureSwitch$);
    const inlineTemplatesEnabled =
      features[FeatureSwitchKey.StructuredPromptInlineTemplates] ?? false;
    const restoredDraft = userMessageDraftState(
      threadDraft,
      inlineTemplatesEnabled,
    );
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
      set(thread.draft.seed$, {
        content: restoredDraft.content,
        userMessage: restoredDraft.userMessage,
        generationTemplate: restoredDraft.generationTemplate,
        attachments: restoredAttachments,
      });
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
      set(thread.subscribeChatThread$, signal),
      set(autoOpenThreadSidebar$, thread, signal),
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

    L.debug("setupPaneThread$ start", { threadId });

    const { draft, isNew } = set(ensureDraft$, threadId);
    const dataSource = createRemoteChatThreadDataSource(threadId);
    const initialOptimisticEntries = get(
      createOptimisticChatMessagesForThread(threadId),
    );
    const features = get(featureSwitch$);
    const inlineTemplatesEnabled =
      features[FeatureSwitchKey.StructuredPromptInlineTemplates] ?? false;
    const thread = createChatThreadSignals(threadId, draft, dataSource, {
      initialOptimisticEntries,
      inlineTemplatesEnabled,
      connectorAuthorization: spec.connectorAuthorization,
    });
    set(spec.setPaneThread$, thread);

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

export const setupLeftThread$ = command(
  async (
    { set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await Promise.all([
      set(syncPrimaryThread$, threadId, parentSignal),
      set(
        setupPaneThread$,
        {
          setPaneThread$: setCurrentLeftThread$,
          resetSetupSignal$: resetLeftSetupSignal$,
          connectorAuthorization: leftPaneConnectorAuthorization,
        },
        threadId,
        parentSignal,
      ),
    ]);
  },
);

export const setupRightThread$ = command(
  async (
    { set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    await set(
      setupPaneThread$,
      {
        setPaneThread$: setCurrentRightThread$,
        resetSetupSignal$: resetRightSetupSignal$,
        connectorAuthorization: rightPaneConnectorAuthorization,
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
