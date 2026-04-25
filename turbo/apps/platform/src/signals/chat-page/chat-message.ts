import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { navigateToChat$ } from "../zero-page/zero-nav.ts";
import {
  currentChatThreadId$,
  chatThreads$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import { setAblyLoop$ } from "../realtime.ts";
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
  pendingThread: ReturnType<typeof createChatThreadSignals>;
  sendResult: Promise<SendNewThreadMessageResult>;
}

export const activateNewChatThreadPageLoops$ = command(
  async (
    { set },
    thread: ReturnType<typeof createChatThreadSignals>,
    threadId: string,
    signal: AbortSignal,
  ) => {
    const onThreadUpdated$ = command(async ({ get, set }, sig: AbortSignal) => {
      const data = await get(thread.threadData$);
      sig.throwIfAborted();
      if (data) {
        set(updateDocumentTitle$, data.title ?? "New chat");
      }
      return false;
    });

    await Promise.all([
      set(thread.runPhraseLoop$, signal),
      set(thread.loadPagedMessages$, signal),
      set(
        setAblyLoop$,
        `chatThreadRunUpdated:${threadId}`,
        onThreadUpdated$,
        signal,
      ),
    ]);
  },
);

/**
 * Send the first message in a new or threadless chat. Returns the threadId.
 * Used by the agent talk page which navigates to the thread after sending.
 *
 * `modelSelection` comes from the composer's per-run model picker and is
 * always provided — `null` stores "no override" (inherit agent/org default)
 * on the newly created thread; a non-null object sets the thread override.
 */
export const sendNewThreadMessage$ = command(
  async (
    { get, set },
    { agentId, prompt, modelSelection }: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<SendNewThreadMessagePending | null> => {
    // Mirror the in-thread send path: resolve the talk-page draft's uploaded
    // attachments so the first message carries structured `attachFiles` just
    // like follow-ups do (fixes #10243 for the new-thread entry point).
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
          createdAt: new Date().toISOString(),
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

    return { threadId, pendingThread: localThread, sendResult };
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
