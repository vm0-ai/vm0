import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  chatMessagesContract,
  chatThreadsContract,
  type ChatThreadListItem,
  type ModelSelectionRequest,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  chatThreads$,
  currentChatAgentId$,
  currentChatThreadId$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type LocalChatThreadSnapshot,
} from "./create-chat-thread.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";

const SIDEBAR_PARAM = "sidebar";

export type OptimisticChatPane = "main" | "sidebar";

interface PendingChatThread {
  pane: OptimisticChatPane;
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

interface OptimisticChatThreads {
  main: PendingChatThread | null;
  sidebar: PendingChatThread | null;
}

const internalOptimisticChatThreads$ = state<OptimisticChatThreads>({
  main: null,
  sidebar: null,
});

export const optimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThreads$).main;
});

export const sidebarOptimisticChatThread$ = computed((get) => {
  return get(internalOptimisticChatThreads$).sidebar;
});

export const clearMatchingOptimisticChatThread$ = command(
  ({ set }, pending: PendingChatThread) => {
    set(internalOptimisticChatThreads$, (current) => {
      if (current[pending.pane] !== pending) {
        return current;
      }
      return { ...current, [pending.pane]: null };
    });
  },
);

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
  ({ get, set }, pending: PendingChatThread) => {
    if (!get(currentChatThreadId$)) {
      return;
    }

    const next = new URLSearchParams(get(searchParams$));
    next.set(SIDEBAR_PARAM, pending.threadId);
    set(updateSearchParams$, next);
  },
);

const showExistingOptimisticChatThread$ = command(
  ({ get, set }, pending: PendingChatThread) => {
    if (pending.pane === "main") {
      if (get(currentChatThreadId$) !== pending.threadId) {
        set(routeMainOptimisticChatThread$, pending);
      }
      return;
    }

    if (get(searchParams$).get(SIDEBAR_PARAM) !== pending.threadId) {
      set(routeSidebarOptimisticChatThread$, pending);
    }
  },
);

const routeOptimisticChatThread$ = command(
  async ({ get, set }, pending: PendingChatThread, signal: AbortSignal) => {
    signal.throwIfAborted();

    signal.addEventListener("abort", () => {
      set(clearMatchingOptimisticChatThread$, pending);
    });
    set(internalOptimisticChatThreads$, (current) => {
      return { ...current, [pending.pane]: pending };
    });

    if (pending.pane === "main") {
      set(routeMainOptimisticChatThread$, pending);
    } else {
      set(routeSidebarOptimisticChatThread$, pending);
    }

    await pending.settleResult.catch((error: unknown) => {
      set(clearMatchingOptimisticChatThread$, pending);
      throw error;
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
    agentComposeId: string | null,
    pane: OptimisticChatPane,
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
    const settleResult = (async (): Promise<void> => {
      await createChatThread(
        createClient,
        resolvedComposeId,
        signal,
        undefined,
        threadId,
      );
      signal.throwIfAborted();
    })();

    return {
      pane,
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
  async (
    { get, set },
    agentComposeId: string | null,
    pane: OptimisticChatPane,
    signal: AbortSignal,
  ) => {
    const targetPane =
      pane === "sidebar" && get(currentChatThreadId$) ? "sidebar" : "main";
    const optimisticThread = get(internalOptimisticChatThreads$)[targetPane];
    if (optimisticThread) {
      set(showExistingOptimisticChatThread$, optimisticThread);
      return;
    }

    const result = await set(
      createNewChatThread$,
      agentComposeId,
      targetPane,
      signal,
    );
    if (!result) {
      return;
    }

    await set(routeOptimisticChatThread$, result, signal);
  },
);

export const pendingOptimisticChatThreads$ = computed(
  async (get): Promise<ChatThreadListItem[]> => {
    const optimisticThreads = Object.values(
      get(internalOptimisticChatThreads$),
    ).filter((thread): thread is PendingChatThread => {
      return thread !== null;
    });
    if (optimisticThreads.length === 0) {
      return [];
    }

    const currentAgentId = await get(currentChatAgentId$);
    if (!currentAgentId) {
      return [];
    }

    const persistedThreads = await get(chatThreads$);
    const persistedThreadIds = new Set(
      persistedThreads.map((thread) => {
        return thread.id;
      }),
    );

    return optimisticThreads
      .filter((thread) => {
        return (
          thread.agentId === currentAgentId &&
          !persistedThreadIds.has(thread.threadId)
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
          isArchived: false,
          running: thread.running,
        };
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
      pane: "main",
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
