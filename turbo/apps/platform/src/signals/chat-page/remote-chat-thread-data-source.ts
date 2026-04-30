import { command, computed, state } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRunsCancelContract } from "@vm0/api-contracts/contracts/zero-runs";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { logger } from "../log.ts";
import type { ChatThread } from "../agent-chat.ts";
import type {
  CancelRunsArgs,
  ChatThreadDataSource,
  InitialPage,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  MarkReadArgs,
  PatchDraftArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";

const L = logger("ChatThread");

const remoteIsCancelRequested$ = computed(() => {
  return false;
});

const patchDraft$ = command(
  async (
    { get },
    { threadId, content, attachments }: PatchDraftArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: threadId },
        body: { draftContent: content, draftAttachments: attachments },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

const listMessagesAfter$ = command(
  async (
    { get },
    { threadId, sinceId }: ListMessagesAfterArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { sinceId, limit: 50 },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    L.debug("fetchNextPage$", {
      threadId,
      sinceId,
      count: result.body.messages.length,
      runStatuses: result.body.messages
        .filter((m) => {
          return m.runId;
        })
        .map((m) => {
          return { id: m.id, runId: m.runId, status: m.status };
        }),
    });
    if (result.body.messages.length === 0) {
      return { messages: [], reachedEnd: true };
    }
    return { messages: result.body.messages, reachedEnd: false };
  },
);

const listMessagesBefore$ = command(
  async (
    { get },
    { threadId, beforeId }: ListMessagesBeforeArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { beforeId, limit: 50 },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return {
      messages: result.body.messages,
      hasMore: result.body.hasHistoryBefore ?? false,
    };
  },
);

const cancelRuns$ = command(
  async (
    { get },
    { threadId, activeRunIds }: CancelRunsArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroRunsCancelContract);
    L.debug("cancelRun$ start", { threadId, pendingRunIds: activeRunIds });
    await Promise.all(
      activeRunIds.map(async (runId) => {
        await accept(
          client.cancel({ params: { id: runId }, fetchOptions: { signal } }),
          [200],
        );
        L.debug("cancelRun$ server accepted cancel", { threadId, runId });
      }),
    );
  },
);

const markRead$ = command(
  async (
    { get },
    { threadId, latestMessageId }: MarkReadArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const client = get(zeroClient$)(chatThreadMarkReadContract);
    const result = await accept(
      client.markRead({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body.lastReadMessageId ?? latestMessageId;
  },
);

const subscribeRealtime$ = command(
  async (
    { set },
    { threadId, handlers }: SubscribeRealtimeArgs,
    signal: AbortSignal,
  ) => {
    await Promise.all([
      set(
        setAblyLoop$,
        `chatThreadMessageCreated:${threadId}`,
        handlers.onMessageCreated$,
        signal,
      ),
      set(
        setAblyLoop$,
        `chatThreadRunCreated:${threadId}`,
        handlers.onRunChanged$,
        signal,
      ),
      set(
        setAblyLoop$,
        `chatThreadRunUpdated:${threadId}`,
        handlers.onRunChanged$,
        signal,
      ),
    ]);
    signal.throwIfAborted();
  },
);

export function createRemoteChatThreadDataSource(
  threadId: string,
): ChatThreadDataSource {
  const reloadCounter$ = state(0);

  const getThread$ = computed(async (get): Promise<ChatThread | null> => {
    get(reloadCounter$);
    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    const threadResult = await accept(
      threadClient.get({ params: { id: threadId } }),
      [200, 404],
      { toast: false },
    );
    if (threadResult.status === 404) {
      return null;
    }
    const body = threadResult.body;
    return {
      id: threadId,
      title: body.title ?? null,
      agentId: body.agentId,
      latestSessionId: body.latestSessionId ?? null,
      lastReadMessageId: body.lastReadMessageId ?? null,
      latestSessionProviderType: body.latestSessionProviderType ?? null,
      activeRunIds: body.activeRunIds,
      activeRuns: body.activeRuns ?? [],
      isLegacySession: false,
      draftContent: body.draftContent ?? null,
      draftAttachments: body.draftAttachments ?? null,
      modelProviderId: body.modelProviderId ?? null,
      selectedModel: body.selectedModel ?? null,
    };
  });

  const reloadThread$ = command(({ set }) => {
    set(reloadCounter$, (v) => {
      return v + 1;
    });
  });

  const initialPage$ = computed(async (get): Promise<InitialPage> => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({ params: { threadId }, query: { limit: 50 } }),
      [200],
    );
    const hasHistoryBefore = result.body.hasHistoryBefore ?? false;
    L.debug("initialPage$", {
      threadId,
      count: result.body.messages.length,
      hasHistoryBefore,
    });
    return { messages: result.body.messages, hasHistoryBefore };
  });

  return {
    getThread$,
    reloadThread$,
    initialPage$,
    patchDraft$,
    listMessagesAfter$,
    listMessagesBefore$,
    cancelRuns$,
    markRead$,
    subscribeRealtime$,
    isCancelRequested$: remoteIsCancelRequested$,
  };
}
