import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { navigateToChat$ } from "../zero-page/zero-nav.ts";
import {
  currentChatThreadId$,
  chatThreads$,
  insertOptimisticChatThread$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type LocalChatThreadSnapshot,
} from "./create-chat-thread.ts";
import {
  chatMessagesContract,
  chatThreadsContract,
  chatThreadByIdContract,
  type ModelSelectionRequest,
  type PagedChatMessage,
} from "@vm0/core/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";

export { chatThreads$, reloadChatThreads$ } from "../agent-chat.ts";

export {
  zeroChatAttachments$,
  uploadZeroAttachment$,
  restoreZeroAttachments$,
  removeZeroAttachment$,
  zeroDragOver$,
  setZeroDragOver$,
  canSendZeroChat$,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";

// ---------------------------------------------------------------------------
// Re-export paged message types from @vm0/core
// ---------------------------------------------------------------------------

export type { PagedChatMessage } from "@vm0/core/contracts/chat-threads";

/** A group of consecutive messages with the same role. */
export interface GroupedChatMessageGroup {
  beginMessageId: string;
  role: "user" | "assistant";
  messages: PagedChatMessage[];
}

// ---------------------------------------------------------------------------
// Thread creation
// ---------------------------------------------------------------------------

async function createChatThread(
  createClient: ZeroClientFactory,
  agentId: string,
  signal: AbortSignal,
  title?: string,
): Promise<{ id: string; title: string | null }> {
  const client = createClient(chatThreadsContract);
  const result = await accept(
    client.create({
      body: { agentId, ...(title ? { title } : {}) },
      fetchOptions: { signal },
    }),
    [201],
  );
  return { id: result.body.id, title: result.body.title };
}

export const createNewChatThread$ = command(
  async (
    { get, set },
    agentComposeId: string | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const resolvedComposeId =
      agentComposeId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;

    if (!resolvedComposeId) {
      toast.error("No agent available for new chat session");
      return null;
    }

    const createClient = get(zeroClient$);
    const thread = await createChatThread(
      createClient,
      resolvedComposeId,
      signal,
    );

    set(reloadChatThreads$);
    return thread.id;
  },
);

// ---------------------------------------------------------------------------
// Send new thread message (used by agent talk page)
// ---------------------------------------------------------------------------

export interface SendNewThreadMessageRequest {
  agentId: string;
  prompt: string;
  modelSelection: ModelSelectionRequest | null;
}

export interface SendNewThreadMessageResult {
  threadId: string;
  runId: string;
}

export interface SendNewThreadMessagePending {
  threadId: string;
  agentId: string;
  pendingThread: ReturnType<typeof createChatThreadSignals>;
  sendResult: Promise<SendNewThreadMessageResult>;
}

export const sendNewThreadMessage$ = command(
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
    set(insertOptimisticChatThread$, {
      id: threadId,
      agentId,
      time: createdAt,
    });
    const cancelRequested$ = state(false);
    const localSnapshot: LocalChatThreadSnapshot = {
      threadData: {
        id: threadId,
        title: null,
        agentId,
        latestSessionId: null,
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

    return { threadId, agentId, pendingThread: localThread, sendResult };
  },
);

// ---------------------------------------------------------------------------
// Delete thread
// ---------------------------------------------------------------------------

export const deleteChatThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const threads = await get(chatThreads$);
    signal.throwIfAborted();

    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(client.delete({ params: { id: threadId } }), [204]);
    signal.throwIfAborted();

    toast.success("Chat deleted");

    if (get(currentChatThreadId$) === threadId) {
      const idx = threads.findIndex((t) => {
        return t.id === threadId;
      });
      const remaining = threads.filter((t) => {
        return t.id !== threadId;
      });
      if (remaining.length === 0) {
        set(detachedNavigateTo$, "/");
      } else {
        const nextThread = remaining[idx] ?? remaining[remaining.length - 1];
        set(navigateToChat$, nextThread.id);
      }
    }

    set(reloadChatThreads$);
  },
);

// ---------------------------------------------------------------------------
// Composer local UI state
// ---------------------------------------------------------------------------

const internalComposerFileInput$ = state<HTMLElement | null>(null);

export const composerFileInput$ = computed((get) => {
  return get(internalComposerFileInput$);
});

export const setComposerFileInput$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalComposerFileInput$, null);
    });
    set(internalComposerFileInput$, el);
  }),
);
