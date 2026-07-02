import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { clerk$ } from "../auth.ts";
import { patchThreadMeta$ } from "../external/idb-thread-meta-store.ts";
import {
  chatMessagesContract,
  chatThreadsContract,
  type AttachFile,
  type GenerationTemplateRequest,
  type ChatThreadListItem,
  type ModelSelectionRequest,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  type ChatThread,
  chatThreads$,
  currentChatAgentId$,
  currentChatThreadId$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  currentLeftThread$,
  currentRightThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import {
  clearArtifactSidebarParams,
  clearChatAutomationSidebarParams,
} from "../zero-page/right-sidebar-search-params.ts";
import {
  talkDraft$,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";
import { clearAgentDraftById$ } from "../zero-page/agent-draft.ts";
import { createChatThreadSignals, ensureDraft$ } from "./create-chat-thread.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import { createLocalChatThreadDataSource } from "./local-chat-thread-data-source.ts";
import type { AppendQueuedMessageArgs } from "./chat-thread-data-source.ts";
import { createPendingChatThread } from "./pending-chat-thread.ts";
import {
  ATTACH_ONLY_PLACEHOLDER,
  isVisualAttachment,
  prepareUserMessageFromDraft$,
  shouldExcludeVisualAttachmentsForModel,
} from "./resolve-draft-attachments.ts";
import {
  appendOptimisticChatMessage$,
  createQueuedOptimisticUserMessagesForThread,
  type OptimisticChatMessageEntry,
} from "./optimistic-chat-messages.ts";
import {
  allPendingChatThreads$,
  clearMatchingOptimisticChatThread$,
  optimisticChatThread$,
  optimisticChatThreadByPane$,
  registerOptimisticChatThread$,
  type OptimisticChatPane,
  type PendingChatThread,
} from "./optimistic-chat-thread-state.ts";
import { sidebarChatThreadsExtraThreads$ } from "./sidebar-chat-threads-pagination.ts";
import { onRejection, toVoid } from "../utils.ts";
import { resolveModelFirstUserDefaultSelection } from "../zero-page/model-default-selection.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import {
  modelSelectionRequestFromSelection,
  runOptionsFromModelProviderSelection,
} from "./model-selection-request.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

export type { OptimisticChatPane };
export { optimisticChatThread$ };

const SIDEBAR_PARAM = "sidebar";

const L = logger("OptimisticChat");

/**
 * Persist the (threadId, agentId) pairing into the IDB cache the moment the
 * client mints a new threadId. Lets `agentId$` resolve from cache on the
 * very first render of the new thread page, before chat-threads/:id returns.
 */
const writeThreadAgentToCache$ = command(
  async (
    { get },
    threadId: string,
    agentId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return;
    }
    await patchThreadMeta$(userId, orgId, threadId, { agentId }, signal);
  },
);

interface SendNewThreadMessageRequest {
  agentId: string;
  prompt: string;
  modelSelection: ModelProviderSelection | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  computerUseHostId?: string | null;
}

interface SendNewThreadMessageResult {
  threadId: string;
  runId: string | null;
}

interface PreparedNewThreadPayload {
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  hasTextContent: boolean;
}

interface SendNewThreadMessagePending extends PendingChatThread {
  sendResult: Promise<SendNewThreadMessageResult>;
}

function newThreadSendBody({
  agentId,
  threadId,
  clientMessageId,
  prepared,
  modelSelection,
  generationTemplate,
  computerUseHostId,
  codexFastModeEnabled,
}: {
  agentId: string;
  threadId: string;
  clientMessageId: string;
  prepared: PreparedNewThreadPayload;
  modelSelection: ModelProviderSelection | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  computerUseHostId?: string | null;
  codexFastModeEnabled: boolean;
}) {
  const runOptions = runOptionsFromModelProviderSelection(
    modelSelection,
    codexFastModeEnabled,
  );
  return {
    agentId,
    prompt: prepared.prompt,
    clientThreadId: threadId,
    hasTextContent: prepared.hasTextContent,
    clientMessageId,
    modelSelection: modelSelectionRequestFromSelection(modelSelection),
    ...(runOptions ? { runOptions } : {}),
    generationTemplate,
    ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
    attachFiles: prepared.attachFiles,
  };
}

function hasVisualDraftAttachments(
  attachments: readonly ZeroChatAttachment[],
): boolean {
  return attachments.some(isVisualAttachment);
}

async function appendQueuedMessage(
  createClient: ZeroClientFactory,
  threadId: string,
  append: AppendQueuedMessageArgs,
  signal: AbortSignal,
): Promise<void> {
  if (
    append.content === null &&
    (!append.attachments || append.attachments.length === 0)
  ) {
    return;
  }

  const client = createClient(chatMessagesContract);
  await accept(
    client.send({
      body: {
        agentId: append.agentId,
        prompt: append.content ?? "",
        threadId,
        hasTextContent: append.hasTextContent,
        clientMessageId: append.clientMessageId,
        modelSelection: append.modelSelection,
        generationTemplate: append.generationTemplate,
        ...(append.computerUseHostId === undefined
          ? {}
          : { computerUseHostId: append.computerUseHostId }),
        attachFiles: append.attachments ?? undefined,
      },
      fetchOptions: { signal },
    }),
    [201],
  );
  signal.throwIfAborted();
}

function hasTextContentForQueuedReplay(message: PagedChatMessage): boolean {
  const content = message.content?.trim() ?? "";
  return content.length > 0 && content !== ATTACH_ONLY_PLACEHOLDER;
}

function queuedReplayAppendArgs({
  threadId,
  agentId,
  modelSelection,
  computerUseHostId,
  entry,
}: {
  threadId: string;
  agentId: string;
  modelSelection: ModelSelectionRequest | null;
  computerUseHostId?: string | null;
  entry: OptimisticChatMessageEntry;
}): AppendQueuedMessageArgs {
  return {
    threadId,
    agentId,
    content: entry.message.content,
    attachments: entry.message.attachFiles ?? null,
    clientMessageId: entry.message.id,
    hasTextContent: hasTextContentForQueuedReplay(entry.message),
    modelSelection,
    generationTemplate: entry.message.generationTemplate,
    computerUseHostId,
  };
}

async function replayQueuedOptimisticMessages({
  createClient,
  threadId,
  agentId,
  modelSelection,
  computerUseHostId,
  entries,
  signal,
}: {
  createClient: ZeroClientFactory;
  threadId: string;
  agentId: string;
  modelSelection: ModelSelectionRequest | null;
  computerUseHostId?: string | null;
  entries: OptimisticChatMessageEntry[];
  signal: AbortSignal;
}): Promise<void> {
  for (const entry of entries) {
    signal.throwIfAborted();
    await appendQueuedMessage(
      createClient,
      threadId,
      queuedReplayAppendArgs({
        threadId,
        agentId,
        modelSelection,
        computerUseHostId,
        entry,
      }),
      signal,
    );
  }
}

const routeMainOptimisticChatThread$ = command(
  ({ get, set }, pending: PendingChatThread) => {
    const next = new URLSearchParams(get(searchParams$));
    if (next.get(SIDEBAR_PARAM) === pending.threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    clearArtifactSidebarParams(next);
    clearChatAutomationSidebarParams(next);
    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: pending.threadId },
      searchParams: next,
    });
  },
);

const routeSidebarOptimisticChatThread$ = command(
  async (
    { get, set },
    pending: PendingChatThread,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!get(currentChatThreadId$)) {
      return;
    }
    await set(loadRightThread$, pending.threadId, signal);
  },
);

const showExistingOptimisticChatThread$ = command(
  async (
    { get, set },
    pending: PendingChatThread,
    signal: AbortSignal,
  ): Promise<void> => {
    if (pending.pane === "main") {
      if (get(currentChatThreadId$) !== pending.threadId) {
        set(routeMainOptimisticChatThread$, pending);
      }
      return;
    }

    if (get(searchParams$).get(SIDEBAR_PARAM) !== pending.threadId) {
      await set(routeSidebarOptimisticChatThread$, pending, signal);
    }
  },
);

const routeOptimisticChatThread$ = command(
  async ({ get, set }, pending: PendingChatThread, signal: AbortSignal) => {
    signal.throwIfAborted();

    signal.addEventListener("abort", () => {
      set(clearMatchingOptimisticChatThread$, pending);
    });
    set(registerOptimisticChatThread$, pending);

    if (pending.pane === "main") {
      set(routeMainOptimisticChatThread$, pending);
    } else {
      await set(routeSidebarOptimisticChatThread$, pending, signal);
    }

    await onRejection(pending.settleResult, () => {
      set(clearMatchingOptimisticChatThread$, pending);
    });
    signal.throwIfAborted();

    if (
      pending.pane === "sidebar" ||
      get(currentChatThreadId$) !== pending.threadId
    ) {
      set(clearMatchingOptimisticChatThread$, pending);
    }
  },
);

const mintOptimisticPendingThread$ = command(
  async (
    { set },
    args: {
      threadId: string;
      agentId: string;
      pendingRunId?: string;
      computerUseHostId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    createdAt: string;
    pendingThread: ChatThreadSignals;
  }> => {
    L.debug("optimistic thread minted", {
      threadId: args.threadId,
      agentId: args.agentId,
    });
    await set(writeThreadAgentToCache$, args.threadId, args.agentId, signal);
    const createdAt = nowDate().toISOString();
    const dataSource = createLocalChatThreadDataSource({
      threadData: createPendingChatThread(
        args.threadId,
        args.agentId,
        args.pendingRunId,
        args.computerUseHostId ?? null,
      ),
      messages: [],
    });
    const { draft } = set(ensureDraft$, args.threadId);
    const pendingThread = createChatThreadSignals(
      args.threadId,
      draft,
      dataSource,
    );
    return { createdAt, pendingThread };
  },
);

async function createChatThread(
  createClient: ZeroClientFactory,
  agentId: string,
  signal: AbortSignal,
  title: string | undefined,
  clientThreadId: string,
): Promise<void> {
  const client = createClient(chatThreadsContract);
  await accept(
    client.create({
      body: {
        agentId,
        clientThreadId,
        ...(title ? { title } : {}),
      },
      fetchOptions: { signal },
    }),
    [201],
  );
}

const createNewChatThread$ = command(
  async (
    { get, set },
    agentId: string,
    pane: OptimisticChatPane,
    signal: AbortSignal,
  ): Promise<PendingChatThread> => {
    const threadId = crypto.randomUUID();
    const { createdAt, pendingThread } = await set(
      mintOptimisticPendingThread$,
      { threadId, agentId },
      signal,
    );

    const createClient = get(zeroClient$);
    L.debug("createNewChatThread$ POST chat-threads start", { threadId });
    const settleResult = (async (): Promise<void> => {
      await createChatThread(
        createClient,
        agentId,
        signal,
        undefined,
        threadId,
      );
      L.debug("createNewChatThread$ POST chat-threads 201", { threadId });
      signal.throwIfAborted();
    })();

    return {
      pane,
      threadId,
      agentId,
      createdAt,
      running: false,
      pendingThread,
      settleResult,
    };
  },
);

export const createNewChatThreadOptimistically$ = command(
  async (
    { get, set },
    agentId: string,
    pane: OptimisticChatPane,
    signal: AbortSignal,
  ) => {
    const targetPane =
      pane === "sidebar" && get(currentChatThreadId$) ? "sidebar" : "main";
    const optimisticThread = get(optimisticChatThreadByPane$)(targetPane);
    if (optimisticThread) {
      await set(showExistingOptimisticChatThread$, optimisticThread, signal);
      return;
    }

    const result = await set(createNewChatThread$, agentId, targetPane, signal);

    await set(routeOptimisticChatThread$, result, signal);
  },
);

function threadToSidebarListItem(thread: ChatThread): ChatThreadListItem {
  return {
    id: thread.id,
    title: thread.title,
    agent: { id: thread.agentId, avatarUrl: null },
    createdAt: thread.createdAt ?? thread.lastMessageAt,
    updatedAt: thread.updatedAt ?? thread.lastMessageAt,
    running: thread.activeRunIds.length > 0,
    pinnedAt: thread.pinnedAt ?? null,
  };
}

function mergeMissingSidebarThreads(
  threads: readonly ChatThreadListItem[],
  missingThreads: readonly ChatThreadListItem[],
): ChatThreadListItem[] {
  if (missingThreads.length === 0) {
    return [...threads];
  }

  const existingIds = new Set(
    threads.map((thread) => {
      return thread.id;
    }),
  );
  const seenMissingIds = new Set<string>();
  const dedupedMissingThreads = missingThreads.filter((thread) => {
    if (existingIds.has(thread.id) || seenMissingIds.has(thread.id)) {
      return false;
    }
    seenMissingIds.add(thread.id);
    return true;
  });
  if (dedupedMissingThreads.length === 0) {
    return [...threads];
  }

  const missingPinned = dedupedMissingThreads.filter((thread) => {
    return thread.pinnedAt !== null && thread.pinnedAt !== undefined;
  });
  const missingUnpinned = dedupedMissingThreads.filter((thread) => {
    return thread.pinnedAt === null || thread.pinnedAt === undefined;
  });
  const firstUnpinnedIndex = threads.findIndex((thread) => {
    return thread.pinnedAt === null || thread.pinnedAt === undefined;
  });

  if (firstUnpinnedIndex === -1) {
    return [...missingPinned, ...threads, ...missingUnpinned];
  }

  return [
    ...missingPinned,
    ...threads.slice(0, firstUnpinnedIndex),
    ...missingUnpinned,
    ...threads.slice(firstUnpinnedIndex),
  ];
}

/**
 * Unified sidebar list: server-ordered persisted threads merged with the
 * optimistic-only pending threads for the current agent, deduped by id.
 *
 * Returning a single signal — instead of letting the sidebar read persisted
 * and optimistic separately — guarantees that the optimistic→persisted
 * handoff happens in one ccstate compute. That removes the React render
 * window where two `useLastResolved` subscribers update one after the other
 * and briefly emit two `<ChatThreadItem>` siblings sharing the same `key`.
 *
 * The server orders each pinned/non-pinned segment by lastMessageAt desc and
 * id desc, but the list item contract does not expose lastMessageAt. Preserve
 * the server order for existing rows and insert optimistic rows at the front
 * of their pinned/non-pinned segment. The frontend must not sort this list.
 */
export const sidebarChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const persisted = await get(chatThreads$);
    const extraPersisted = await get(sidebarChatThreadsExtraThreads$);
    const pending = get(allPendingChatThreads$);
    const currentAgentId = await get(currentChatAgentId$);
    if (!currentAgentId) {
      return [...persisted, ...extraPersisted];
    }

    const persistedIds = new Set(
      [...persisted, ...extraPersisted].map((thread) => {
        return thread.id;
      }),
    );
    const optimisticItems: ChatThreadListItem[] = pending
      .filter((thread) => {
        return (
          thread.agentId === currentAgentId &&
          !persistedIds.has(thread.threadId)
        );
      })
      .map((thread) => {
        return {
          id: thread.threadId,
          title: null,
          agent: { id: thread.agentId, avatarUrl: null },
          createdAt: thread.createdAt,
          updatedAt: thread.createdAt,
          running: thread.running,
        };
      });

    const mergedThreads = mergeMissingSidebarThreads(
      [...persisted, ...extraPersisted],
      optimisticItems,
    );

    const mergedThreadIds = new Set(
      mergedThreads.map((thread) => {
        return thread.id;
      }),
    );
    const activePaneThreads = [
      get(currentLeftThread$),
      get(currentRightThread$),
    ].filter((thread): thread is ChatThreadSignals => {
      return thread !== null && !mergedThreadIds.has(thread.threadId);
    });

    if (activePaneThreads.length === 0) {
      return mergedThreads;
    }

    const activeItems = (
      await Promise.all(
        activePaneThreads.map(async (thread) => {
          const threadData = await get(thread.threadData$);
          if (!threadData || threadData.agentId !== currentAgentId) {
            return null;
          }
          return threadToSidebarListItem(threadData);
        }),
      )
    ).filter((thread): thread is ChatThreadListItem => {
      return thread !== null;
    });

    return mergeMissingSidebarThreads(mergedThreads, activeItems);
  },
);

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<SendNewThreadMessagePending | null> => {
    const { agentId, prompt, modelSelection, generationTemplate } = request;
    const { computerUseHostId } = request;
    const draft = get(talkDraft$);
    const hasVisualAttachments = hasVisualDraftAttachments(
      get(draft.attachments$),
    );
    let effectiveSelectedModel = modelSelection?.selectedModel;
    if (!effectiveSelectedModel && hasVisualAttachments) {
      const policies = await get(orgModelPolicies$);
      signal.throwIfAborted();
      const userPreference = await get(userModelPreference$);
      signal.throwIfAborted();
      effectiveSelectedModel =
        resolveModelFirstUserDefaultSelection({
          userPreference,
          policies,
        })?.selectedModel ?? undefined;
    }
    const prepared = await set(
      prepareUserMessageFromDraft$,
      draft,
      prompt,
      {
        excludeVisualAttachments: shouldExcludeVisualAttachmentsForModel(
          effectiveSelectedModel,
        ),
      },
      signal,
    );
    if (!prepared) {
      return null;
    }
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    set(appendOptimisticChatMessage$, {
      threadId,
      optimisticUserMessageAssociation: "run",
      message: {
        id: clientMessageId,
        role: "user",
        content: prepared.prompt,
        attachFiles: prepared.attachments,
        generationTemplate,
        createdAt: nowDate().toISOString(),
      },
    });
    const { createdAt, pendingThread } = await set(
      mintOptimisticPendingThread$,
      {
        threadId,
        agentId,
        pendingRunId: `pending-${threadId}`,
        computerUseHostId,
      },
      signal,
    );
    set(draft.clear$);
    const clearDraftResult = set(clearAgentDraftById$, agentId, signal);
    const createClient = get(zeroClient$);
    const queuedOptimisticMessages$ =
      createQueuedOptimisticUserMessagesForThread(threadId);
    L.debug("sendNewThreadMessage$ POST chat/messages start", {
      threadId,
      clientMessageId,
    });
    const sendResult = (async (): Promise<SendNewThreadMessageResult> => {
      const [, result] = await Promise.all([
        clearDraftResult,
        accept(
          createClient(chatMessagesContract).send({
            body: newThreadSendBody({
              agentId,
              threadId,
              clientMessageId,
              prepared,
              modelSelection,
              generationTemplate,
              computerUseHostId,
              codexFastModeEnabled:
                get(featureSwitch$)[FeatureSwitchKey.CodexFastMode] ?? false,
            }),
            fetchOptions: { signal },
          }),
          [201],
        ),
      ]);
      signal.throwIfAborted();
      L.debug("sendNewThreadMessage$ POST chat/messages 201", {
        threadId: result.body.threadId,
        runId: result.body.runId,
      });
      const queuedMessages = await get(queuedOptimisticMessages$);
      signal.throwIfAborted();
      const replayModelSelection = await get(pendingThread.modelSelection$);
      const replayComputerUseHostId = await get(
        pendingThread.computerUseHostId$,
      );
      signal.throwIfAborted();
      await replayQueuedOptimisticMessages({
        createClient,
        threadId: result.body.threadId,
        agentId,
        modelSelection:
          modelSelectionRequestFromSelection(replayModelSelection),
        computerUseHostId:
          computerUseHostId === undefined ? undefined : replayComputerUseHostId,
        entries: queuedMessages,
        signal,
      });
      set(reloadChatThreads$);
      return { threadId: result.body.threadId, runId: result.body.runId };
    })();
    return {
      pane: "main",
      threadId,
      agentId,
      createdAt,
      running: true,
      pendingThread,
      sendResult,
      settleResult: toVoid(sendResult),
    };
  },
);

export const sendNewThreadOptimistically$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ) => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return;
    }

    await set(routeOptimisticChatThread$, result, signal);
  },
);
