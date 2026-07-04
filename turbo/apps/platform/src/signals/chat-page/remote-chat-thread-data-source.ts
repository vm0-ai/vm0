import { command, computed, state, type Command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
  chatThreadMessagesContract,
  chatMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  modelSelectionRequestFromSelection,
  threadCodexServiceTierFromSelection,
} from "./model-selection-request.ts";
import { setAblyLoop$, setAblyPayloadLoop$ } from "../realtime.ts";
import {
  createDeferredPromise,
  resetSignalScope,
  settle,
  withCleanup,
} from "../utils.ts";
import { logger } from "../log.ts";
import { reloadSidebarDraftThreads$ } from "./sidebar-draft-threads.ts";
import {
  applyUnreadSnapshot$,
  recordOptimisticReadMark$,
} from "./sidebar-unread-threads.ts";
import type { ChatThread } from "../agent-chat.ts";
import type {
  CancelRunsArgs,
  ChatThreadDataSource,
  InitialPage,
  AppendQueuedMessageArgs,
  GetMessageArgs,
  ListMessagesAfterArgs,
  ListMessagesBeforeArgs,
  MarkReadArgs,
  PatchComputerUseHostArgs,
  PatchModelSelectionArgs,
  PatchDraftArgs,
  RecallMessageArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";

const L = logger("ChatThread");

type ChatRealtimeSubscription =
  | {
      readonly kind: "loop";
      readonly topic: string;
      readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
    }
  | {
      readonly kind: "payload";
      readonly topic: string;
      readonly loopCommand$: Command<
        Promise<boolean> | boolean,
        [unknown, AbortSignal]
      >;
    };

const patchDraft$ = command(
  async (
    { get, set },
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
      [200, 204],
    );
    signal.throwIfAborted();
    set(reloadSidebarDraftThreads$);
  },
);

const patchModelSelection$ = command(
  async (
    { get },
    { threadId, modelSelection }: PatchModelSelectionArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadModelSelectionContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: {
          modelSelection: modelSelectionRequestFromSelection(modelSelection),
          codexServiceTier: threadCodexServiceTierFromSelection(modelSelection),
        },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

const patchComputerUseHost$ = command(
  async (
    { get },
    { threadId, computerUseHostId }: PatchComputerUseHostArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadComputerUseHostContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { computerUseHostId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

const appendQueuedMessage$ = command(
  async (
    { get },
    {
      threadId,
      agentId,
      content,
      attachments,
      clientMessageId,
      hasTextContent,
      modelSelection,
      generationTemplate,
      computerUseHostId,
      runOptions,
    }: AppendQueuedMessageArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatMessagesContract);
    const result = await accept(
      client.send({
        body: {
          agentId,
          prompt: content ?? "",
          threadId,
          hasTextContent,
          clientMessageId,
          modelSelection,
          generationTemplate,
          ...(runOptions ? { runOptions } : {}),
          ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
          attachFiles: attachments ?? undefined,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    return {
      id: clientMessageId,
      role: "user" as const,
      content,
      attachFiles: attachments ?? undefined,
      generationTemplate,
      createdAt: result.body.createdAt ?? nowDate().toISOString(),
    };
  },
);

const recallMessage$ = command(
  async (
    { get },
    { threadId, agentId, revokesMessageId, clientMessageId }: RecallMessageArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatMessagesContract);
    const result = await accept(
      client.send({
        body: {
          agentId,
          threadId,
          revokesMessageId,
          clientMessageId,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    return {
      id: clientMessageId,
      role: "user" as const,
      content: null,
      revokesMessageId,
      createdAt: result.body.createdAt ?? nowDate().toISOString(),
    };
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
      runMessages: result.body.messages.flatMap((m) => {
        if (m.role !== "assistant" || !m.runId) {
          return [];
        }
        return [
          {
            id: m.id,
            runId: m.runId,
          },
        ];
      }),
    });
    return {
      messages: result.body.messages,
      reachedEnd: result.body.messages.length < 50,
    };
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

const getMessage$ = command(
  async (
    { get },
    { threadId, messageId }: GetMessageArgs,
    signal: AbortSignal,
  ): Promise<PagedChatMessage | null> => {
    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.get({
        params: { threadId, messageId },
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    if (result.status === 404) {
      return null;
    }
    return result.body;
  },
);

const cancelRuns$ = command(
  async (
    { get },
    { threadId, agentId, interrupts }: CancelRunsArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatMessagesContract);
    L.debug("cancelRun$ start", {
      threadId,
      pendingRunIds: interrupts.map((interrupt) => {
        return interrupt.runId;
      }),
    });
    await Promise.all(
      interrupts.map(async ({ runId, clientMessageId }) => {
        await accept(
          client.send({
            body: {
              agentId,
              threadId,
              interruptsRunId: runId,
              clientMessageId,
            },
            fetchOptions: { signal },
          }),
          [201],
        );
        L.debug("cancelRun$ server accepted cancel", { threadId, runId });
      }),
    );
  },
);

const markRead$ = command(
  async (
    { get, set },
    { threadId, latestMessageId }: MarkReadArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    set(recordOptimisticReadMark$, threadId);
    const client = get(zeroClient$)(chatThreadMarkReadContract);
    const result = await accept(
      client.markRead({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(applyUnreadSnapshot$, result.body.unreads);
    return result.body.lastReadMessageId ?? latestMessageId;
  },
);

function createSubscribeRealtime() {
  const resetSubscriptionSignal$ = resetSignalScope();

  return command(
    async (
      { set },
      { threadId, handlers }: SubscribeRealtimeArgs,
      signal: AbortSignal,
    ) => {
      const subscriptionScope = set(resetSubscriptionSignal$, signal);
      const subscriptionSignal = subscriptionScope.signal;

      await withCleanup(
        (async () => {
          const ready = createDeferredPromise<void>(subscriptionSignal);
          const subscriptions: ChatRealtimeSubscription[] = [
            {
              kind: "loop",
              topic: `chatThreadMessageCreated:${threadId}`,
              loopCommand$: handlers.onMessageCreated$,
            },
            {
              kind: "payload",
              topic: `chatThreadMessageUpdated:${threadId}`,
              loopCommand$: handlers.onMessageUpdated$,
            },
            {
              kind: "loop",
              topic: `chatThreadRunCreated:${threadId}`,
              loopCommand$: handlers.onRunChanged$,
            },
            {
              kind: "loop",
              topic: `chatThreadRunUpdated:${threadId}`,
              loopCommand$: handlers.onRunChanged$,
            },
            {
              kind: "loop",
              topic: `chatThreadAutomationsChanged:${threadId}`,
              loopCommand$: handlers.onAutomationsChanged$,
            },
          ];

          let pendingSubscriptions = subscriptions.length;
          const markSubscribed = () => {
            pendingSubscriptions -= 1;
            if (pendingSubscriptions === 0 && !ready.settled()) {
              ready.resolve();
            }
          };
          const options = { onSubscribed: markSubscribed };
          const startSubscription = async (
            subscription: ChatRealtimeSubscription,
          ) => {
            if (subscription.kind === "loop") {
              await set(
                setAblyLoop$,
                {
                  topic: subscription.topic,
                  loopCommand$: subscription.loopCommand$,
                  options,
                },
                subscriptionSignal,
              );
            } else {
              await set(
                setAblyPayloadLoop$,
                {
                  topic: subscription.topic,
                  loopCommand$: subscription.loopCommand$,
                  options,
                },
                subscriptionSignal,
              );
            }
            subscriptionSignal.throwIfAborted();
            if (ready.settled()) {
              return;
            }
            const error = new Error(
              `Realtime subscription ended before ready: ${subscription.topic}`,
            );
            ready.reject(error);
            throw error;
          };
          const subscriptionPromises = subscriptions.map(startSubscription);
          const subscription = Promise.all(subscriptionPromises);

          await Promise.race([ready.promise, subscription]);
          subscriptionSignal.throwIfAborted();
          if (ready.settled() && handlers.onSubscribed$) {
            const synced = await settle(
              Promise.resolve(set(handlers.onSubscribed$, subscriptionSignal)),
              subscriptionSignal,
            );
            subscriptionSignal.throwIfAborted();
            if (!synced.ok) {
              subscriptionScope.abort();
              await Promise.allSettled(subscriptionPromises);
              signal.throwIfAborted();
              throw synced.error;
            }
          }
          await subscription;
          subscriptionSignal.throwIfAborted();
        })(),
        () => {
          subscriptionScope.abort(signal.reason);
        },
      );
    },
  );
}

export function createRemoteChatThreadDataSource(
  threadId: string,
): ChatThreadDataSource {
  const reloadCounter$ = state(0);
  const subscribeRealtime$ = createSubscribeRealtime();

  const getThread$ = computed(async (get): Promise<ChatThread | null> => {
    get(reloadCounter$);
    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    const threadResult = await accept(
      threadClient.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (threadResult.status === 404) {
      return null;
    }
    const body = threadResult.body;
    return {
      lastReadMessageId: body.lastReadMessageId ?? null,
      draftContent: body.draftContent ?? null,
      draftAttachments: body.draftAttachments ?? null,
      computerUseHostId: body.computerUseHostId ?? null,
      selectedModel: body.selectedModel ?? null,
      codexServiceTier: body.codexServiceTier ?? null,
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
      [200, 404],
    );
    if (result.status === 404) {
      // Thread metadata owns not-found routing; returning an empty page keeps
      // the messages stream from rejecting in parallel.
      return { messages: [], hasHistoryBefore: false };
    }
    const hasHistoryBefore = result.body.hasHistoryBefore ?? false;
    L.debug("initialPage$", {
      threadId,
      count: result.body.messages.length,
      hasHistoryBefore,
    });
    return {
      messages: result.body.messages,
      hasHistoryBefore,
      fetchedFromRemote: true,
    };
  });

  return {
    getThread$,
    reloadThread$,
    initialPage$,
    patchDraft$,
    patchModelSelection$,
    patchComputerUseHost$,
    appendQueuedMessage$,
    recallMessage$,
    listMessagesAfter$,
    listMessagesBefore$,
    getMessage$,
    cancelRuns$,
    markRead$,
    subscribeRealtime$,
  };
}
