import { command, computed, state, type Command } from "ccstate";
import type {
  ChatThreadDraft,
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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
import { clearArtifactPreview$ } from "../zero-page/zero-artifact-sidebar.ts";
import { closeMailDraftSidebar$ } from "../zero-page/mail-draft-sidebar.ts";
import { createChatThreadSignals, ensureDraft$ } from "./create-chat-thread.ts";
import { createOptimisticChatMessagesForThread } from "./optimistic-chat-messages.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import { closeHeaderAutomationSidebar$ } from "./header-automation-sidebar.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
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

interface RestoredDraftState {
  readonly content: string;
  readonly structuredPrompt: UserMessageDocument | null;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: PersistedAttachment[];
}

function legacyDraftState(threadDraft: ChatThreadDraft): RestoredDraftState {
  return {
    content: threadDraft.draftContent ?? "",
    structuredPrompt: null,
    generationTemplate: undefined,
    attachments: threadDraft.draftAttachments ?? [],
  };
}

function structuredDraftAttachments(
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

function structuredDraftState(
  threadDraft: ChatThreadDraft,
  inlineTemplatesEnabled: boolean,
): RestoredDraftState | null {
  const document = threadDraft.draftStructuredPrompt;
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
    structuredPrompt: document,
    generationTemplate:
      !inlineTemplatesEnabled && generationTemplate?.type === "template"
        ? generationTemplate.template
        : undefined,
    attachments: structuredDraftAttachments(
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
    const structuredPromptEnabled =
      features[FeatureSwitchKey.StructuredPrompt] ?? false;
    const inlineTemplatesEnabled =
      structuredPromptEnabled &&
      (features[FeatureSwitchKey.StructuredPromptInlineTemplates] ?? false);
    const restoredDraft = structuredPromptEnabled
      ? (structuredDraftState(threadDraft, inlineTemplatesEnabled) ??
        legacyDraftState(threadDraft))
      : legacyDraftState(threadDraft);
    const hasDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.structuredPrompt !== null ||
      restoredDraft.attachments.length > 0;
    if (isNew && hasDraft) {
      const restoredAttachments = restoredDraft.attachments.map(
        createRestoredAttachment,
      );
      set(thread.draft.seed$, {
        content: restoredDraft.content,
        structuredPrompt: restoredDraft.structuredPrompt,
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
      (features[FeatureSwitchKey.StructuredPrompt] ?? false) &&
      (features[FeatureSwitchKey.StructuredPromptInlineTemplates] ?? false);
    const thread = createChatThreadSignals(
      threadId,
      draft,
      dataSource,
      initialOptimisticEntries,
      inlineTemplatesEnabled,
    );
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
          setPaneThread$: setLeftThread$,
          resetSetupSignal$: resetLeftSetupSignal$,
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
        setPaneThread$: setRightThread$,
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

    // Drop right sidebar state before switching threads — open artifact
    // and automation panels are anchored to the previous thread's messages.
    set(clearArtifactPreview$);
    set(closeHeaderAutomationSidebar$);
    set(closeMailDraftSidebar$);

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

    if (get(internalRightThread$)?.threadId === threadId) {
      return;
    }

    const currentRightThread = get(internalRightThread$);
    if (currentRightThread && currentRightThread.threadId !== threadId) {
      set(currentRightThread.resetRenderedChatGroupsIfAtBottom$);
    }

    set(clearArtifactPreview$);
    set(closeHeaderAutomationSidebar$);
    set(closeMailDraftSidebar$);

    const next = new URLSearchParams(get(searchParams$));
    next.set(SIDEBAR_PARAM, threadId);
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId: mainThreadId },
      searchParams: next,
    });
  },
);
