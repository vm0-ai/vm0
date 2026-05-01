import { command, computed } from "ccstate";
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
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { loadRightThread$ } from "./chat-thread-panes.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { createChatThreadSignals, ensureDraft$ } from "./create-chat-thread.ts";
import { createLocalChatThreadDataSource } from "./local-chat-thread-data-source.ts";
import { createPendingChatThread } from "./pending-chat-thread.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";
import {
  allPendingChatThreads$,
  clearMatchingOptimisticChatThread$,
  optimisticChatThread$,
  optimisticChatThreadByPane$,
  registerOptimisticChatThread$,
  type OptimisticChatPane,
  type PendingChatThread,
} from "./optimistic-chat-thread-state.ts";

export type { OptimisticChatPane };
export { optimisticChatThread$ };

const SIDEBAR_PARAM = "sidebar";

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

    // Funnel through loadRightThread$ so the optimistic flow goes through
    // the same setup as URL-driven loads (settleResult swap, draft seeding,
    // Ably subscription). loadRightThread$ reads sidebarOptimisticChatThread$
    // synchronously and publishes pending.pendingThread before its first
    // await, so the sidebar paints without delay.
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
    const dataSource = createLocalChatThreadDataSource({
      threadData: createPendingChatThread(threadId, resolvedComposeId),
      messages: [],
    });
    const { draft: threadDraft } = set(ensureDraft$, threadId);
    const localThread = createChatThreadSignals(
      threadId,
      threadDraft,
      dataSource,
    );
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
    const optimisticThread = get(optimisticChatThreadByPane$)(targetPane);
    if (optimisticThread) {
      await set(showExistingOptimisticChatThread$, optimisticThread, signal);
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
    const optimisticThreads = get(allPendingChatThreads$);
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
    const dataSource = createLocalChatThreadDataSource({
      threadData: createPendingChatThread(
        threadId,
        agentId,
        `pending-${threadId}`,
      ),
      messages: [
        {
          id: clientMessageId,
          role: "user",
          content: prepared.prompt,
          attachFiles: prepared.attachments,
          createdAt,
        },
      ],
    });
    const { draft: threadDraft } = set(ensureDraft$, threadId);
    const localThread = createChatThreadSignals(
      threadId,
      threadDraft,
      dataSource,
    );
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
