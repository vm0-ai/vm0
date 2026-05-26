import { command, computed } from "ccstate";
import { clerk$ } from "../auth.ts";
import { patchThreadMeta$ } from "../external/idb-thread-meta-store.ts";
import {
  chatMessagesContract,
  chatThreadsContract,
  type ChatThreadListItem,
  type ModelSelectionRequest,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  chatThreads$,
  currentChatAgentId$,
  currentChatThreadId$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { loadRightThread$ } from "./chat-thread-panes.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "./create-chat-thread.ts";
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
import { onRejection, toVoid } from "../utils.ts";
import { resolveModelFirstUserDefaultSelection } from "../zero-page/model-default-selection.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { logger } from "../log.ts";

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
  modelSelection: ModelSelectionRequest | null;
}

interface SendNewThreadMessageResult {
  threadId: string;
  runId: string | null;
}

interface SendNewThreadMessagePending extends PendingChatThread {
  sendResult: Promise<SendNewThreadMessageResult>;
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
        attachFiles: append.attachments ?? undefined,
        ...(append.forceNewSession ? { forceNewSession: true } : {}),
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
  entry,
}: {
  threadId: string;
  agentId: string;
  modelSelection: ModelSelectionRequest | null;
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
    ...(entry.forceNewSession ? { forceNewSession: true } : {}),
  };
}

async function replayQueuedOptimisticMessages({
  createClient,
  threadId,
  agentId,
  modelSelection,
  entries,
  signal,
}: {
  createClient: ZeroClientFactory;
  threadId: string;
  agentId: string;
  modelSelection: ModelSelectionRequest | null;
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
    const createdAt = new Date().toISOString();
    const dataSource = createLocalChatThreadDataSource({
      threadData: createPendingChatThread(
        args.threadId,
        args.agentId,
        args.pendingRunId,
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

/**
 * Unified sidebar list: persisted threads merged with the optimistic-only
 * pending threads for the current agent, deduped by id, sorted (pinned first
 * then most-recent activity desc).
 *
 * Returning a single signal — instead of letting the sidebar read persisted
 * and optimistic separately — guarantees that the optimistic→persisted
 * handoff happens in one ccstate compute. That removes the React render
 * window where two `useLastResolved` subscribers update one after the other
 * and briefly emit two `<ChatThreadItem>` siblings sharing the same `key`.
 *
 * Sort key:
 * - When the persisted version exists, dedupe drops the optimistic entry and
 *   the server's `updatedAt` decides position.
 * - While only the optimistic exists, its browser-side `createdAt` (captured
 *   when `createNewChatThread$` minted the threadId) participates in the
 *   same sort, so a freshly-created thread lands at the top of the unpinned
 *   section without being pinned to a fixed slot.
 */
export const sidebarChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const persisted = await get(chatThreads$);
    const pending = get(allPendingChatThreads$);
    if (pending.length === 0) {
      return persisted;
    }

    const currentAgentId = await get(currentChatAgentId$);
    if (!currentAgentId) {
      return persisted;
    }

    const persistedIds = new Set(
      persisted.map((thread) => {
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
          isRead: true,
          running: thread.running,
        };
      });

    if (optimisticItems.length === 0) {
      return persisted;
    }

    return [...persisted, ...optimisticItems].sort((a, b) => {
      const aPinned = a.pinnedAt ? 0 : 1;
      const bPinned = b.pinnedAt ? 0 : 1;
      if (aPinned !== bPinned) {
        return aPinned - bPinned;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  },
);

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    { agentId, prompt, modelSelection }: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<SendNewThreadMessagePending | null> => {
    const draft = get(talkDraft$);
    const hasVisualAttachments = get(draft.attachments$).some((attachment) => {
      return isVisualAttachment(attachment);
    });
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
    const messageCreatedAt = new Date().toISOString();
    set(appendOptimisticChatMessage$, {
      threadId,
      optimisticUserMessageAssociation: "run",
      message: {
        id: clientMessageId,
        role: "user",
        content: prepared.prompt,
        attachFiles: prepared.attachments,
        createdAt: messageCreatedAt,
      },
    });
    const { createdAt, pendingThread } = await set(
      mintOptimisticPendingThread$,
      {
        threadId,
        agentId,
        pendingRunId: `pending-${threadId}`,
      },
      signal,
    );
    set(draft.clear$);

    const createClient = get(zeroClient$);
    const client = createClient(chatMessagesContract);
    const queuedOptimisticMessages$ =
      createQueuedOptimisticUserMessagesForThread(threadId);
    L.debug("sendNewThreadMessage$ POST chat/messages start", {
      threadId,
      clientMessageId,
    });
    const sendResult = (async (): Promise<SendNewThreadMessageResult> => {
      const result = await accept(
        client.send({
          body: {
            agentId,
            prompt: prepared.prompt,
            clientThreadId: threadId,
            hasTextContent: prepared.hasTextContent,
            clientMessageId,
            modelSelection,
            attachFiles: prepared.attachFiles,
          },
          fetchOptions: { signal },
        }),
        [201],
      );
      signal.throwIfAborted();
      L.debug("sendNewThreadMessage$ POST chat/messages 201", {
        threadId: result.body.threadId,
        runId: result.body.runId,
      });
      const queuedMessages = await get(queuedOptimisticMessages$);
      signal.throwIfAborted();
      const replayModelSelection = await get(pendingThread.modelSelection$);
      signal.throwIfAborted();
      await replayQueuedOptimisticMessages({
        createClient,
        threadId: result.body.threadId,
        agentId,
        modelSelection: replayModelSelection,
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
