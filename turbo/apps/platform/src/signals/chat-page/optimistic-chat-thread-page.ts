import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  chatMessagesContract,
  chatThreadsContract,
  type ChatThreadListItem,
  type ModelSelectionRequest,
} from "@vm0/core/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  chatThreads$,
  currentChatAgentId$,
  currentChatThreadId$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type LocalChatThreadSnapshot,
} from "./create-chat-thread.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";

interface PendingChatThread {
  threadId: string;
  agentId: string;
  createdAt: string;
  running: boolean;
  pendingThread: ReturnType<typeof createChatThreadSignals>;
  settleResult: Promise<void>;
}

interface SendNewThreadMessageRequest {
  agentId: string;
  prompt: string;
  modelSelection: ModelSelectionRequest | null;
}

interface SendNewThreadMessageResult {
  threadId: string;
  runId: string;
}

interface SendNewThreadMessagePending extends PendingChatThread {
  sendResult: Promise<SendNewThreadMessageResult>;
}

const internalOptimisticChatThread$ = state<PendingChatThread | null>(null);

export const optimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThread$);
});

export const clearMatchingOptimisticChatThread$ = command(
  ({ set }, pending: PendingChatThread) => {
    set(internalOptimisticChatThread$, (current) => {
      return current === pending ? null : current;
    });
  },
);

const routeOptimisticChatThread$ = command(
  async ({ get, set }, pending: PendingChatThread, signal: AbortSignal) => {
    signal.throwIfAborted();

    signal.addEventListener("abort", () => {
      set(clearMatchingOptimisticChatThread$, pending);
    });
    set(internalOptimisticChatThread$, pending);

    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: pending.threadId },
    });

    await pending.settleResult.catch((error: unknown) => {
      set(clearMatchingOptimisticChatThread$, pending);
      throw error;
    });
    signal.throwIfAborted();

    if (get(currentChatThreadId$) !== pending.threadId) {
      set(clearMatchingOptimisticChatThread$, pending);
    }
  },
);

async function createChatThread(
  createClient: ZeroClientFactory,
  agentId: string,
  signal: AbortSignal,
  title: string | undefined,
  clientThreadId: string,
): Promise<{ id: string; title: string | null }> {
  const client = createClient(chatThreadsContract);
  const result = await accept(
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
  return { id: result.body.id, title: result.body.title };
}

const createNewChatThread$ = command(
  async (
    { get, set },
    agentComposeId: string | null,
    signal: AbortSignal,
  ): Promise<PendingChatThread | null> => {
    const resolvedComposeId =
      agentComposeId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;
    signal.throwIfAborted();

    if (!resolvedComposeId) {
      toast.error("No agent available for new chat session");
      return null;
    }

    const threadId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const cancelRequested$ = state(false);
    const localSnapshot: LocalChatThreadSnapshot = {
      threadData: {
        id: threadId,
        title: null,
        agentId: resolvedComposeId,
        latestSessionId: null,
        lastReadMessageId: null,
        latestSessionProviderType: null,
        activeRunIds: [],
        activeRuns: [],
        isLegacySession: false,
        draftContent: null,
        draftAttachments: null,
        modelProviderId: null,
        selectedModel: null,
      },
      messages: [],
      cancelRequested$,
    };
    const { draft: threadDraft } = set(ensureDraft$, threadId);
    const localThread = createChatThreadSignals(threadId, threadDraft, {
      localSnapshot,
    });
    set(localThread.hideSkeleton$);

    const createClient = get(zeroClient$);
    const settleResult = (async () => {
      const thread = await createChatThread(
        createClient,
        resolvedComposeId,
        signal,
        undefined,
        threadId,
      );
      signal.throwIfAborted();

      if (thread.id !== threadId) {
        set(detachedNavigateTo$, "/chats/:threadId", {
          pathParams: { threadId: thread.id },
          replace: true,
        });
      }
    })();

    return {
      threadId,
      agentId: resolvedComposeId,
      createdAt,
      running: false,
      pendingThread: localThread,
      settleResult,
    };
  },
);

export const createNewChatThreadOptimistically$ = command(
  async ({ get, set }, agentComposeId: string | null, signal: AbortSignal) => {
    const optimisticThread = get(optimisticChatThread$);
    if (optimisticThread) {
      if (get(currentChatThreadId$) !== optimisticThread.threadId) {
        set(detachedNavigateTo$, "/chats/:threadId", {
          pathParams: { threadId: optimisticThread.threadId },
        });
      }
      return;
    }

    const result = await set(createNewChatThread$, agentComposeId, signal);
    if (!result) {
      return;
    }

    await set(routeOptimisticChatThread$, result, signal);
  },
);

export const pendingOptimisticChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const optimisticThread = get(optimisticChatThread$);
    if (!optimisticThread) {
      return [];
    }

    const currentAgentId = await get(currentChatAgentId$);
    if (!currentAgentId || optimisticThread.agentId !== currentAgentId) {
      return [];
    }

    const persistedThreads = await get(chatThreads$);
    if (
      persistedThreads.some((thread) => {
        return thread.id === optimisticThread.threadId;
      })
    ) {
      return [];
    }

    return [
      {
        id: optimisticThread.threadId,
        title: null,
        agent: { id: optimisticThread.agentId, avatarUrl: null },
        createdAt: optimisticThread.createdAt,
        updatedAt: optimisticThread.createdAt,
        isRead: true,
        isArchived: false,
        running: optimisticThread.running,
      },
    ];
  },
);

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    { agentId, prompt, modelSelection }: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<SendNewThreadMessagePending | null> => {
    const draft = get(talkDraft$);
    const prepared = await set(
      prepareUserMessageFromDraft$,
      draft,
      prompt,
      signal,
    );

    if (!prepared) {
      return null;
    }

    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const cancelRequested$ = state(false);
    const localSnapshot: LocalChatThreadSnapshot = {
      threadData: {
        id: threadId,
        title: null,
        agentId,
        latestSessionId: null,
        lastReadMessageId: null,
        latestSessionProviderType: null,
        activeRunIds: [`pending-${threadId}`],
        activeRuns: [{ id: `pending-${threadId}`, status: "pending" }],
        isLegacySession: false,
        draftContent: null,
        draftAttachments: null,
        modelProviderId: null,
        selectedModel: null,
      },
      messages: [
        {
          id: clientMessageId,
          role: "user",
          content: prepared.prompt,
          attachFiles: prepared.attachments,
          createdAt,
        },
      ],
      cancelRequested$,
    };
    const { draft: threadDraft } = set(ensureDraft$, threadId);
    const localThread = createChatThreadSignals(threadId, threadDraft, {
      localSnapshot,
    });
    set(localThread.hideSkeleton$);
    set(draft.clear$);

    const client = get(zeroClient$)(chatMessagesContract);
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
      set(reloadChatThreads$);

      return { threadId: result.body.threadId, runId: result.body.runId };
    })();

    return {
      threadId,
      agentId,
      createdAt,
      running: true,
      pendingThread: localThread,
      sendResult,
      settleResult: sendResult.then(() => {}),
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
