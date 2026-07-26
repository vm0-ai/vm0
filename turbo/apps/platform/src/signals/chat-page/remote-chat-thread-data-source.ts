import { command, computed, type Command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadMarkReadContract,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
  chatThreadEventsContract,
  chatEventsContract,
  canonicalChatEvent,
  type ChatThreadEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { threadCodexServiceTierFromSelection } from "./model-selection-request.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  createDeferredPromise,
  onRejection,
  resetSignalScope,
  withCleanup,
} from "../utils.ts";
import { logger } from "../log.ts";
import { reloadSidebarDraftThreads$ } from "./sidebar-draft-threads.ts";
import {
  applyUnreadSnapshot$,
  recordOptimisticReadMark$,
} from "./sidebar-unread-threads.ts";
import {
  chatThreadMetaMap$,
  optimisticChatThreadCreateUnsettled,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";
import type {
  CancelRunsArgs,
  AppendQueuedEventArgs,
  ListEventsAfterArgs,
  ListEventsBeforeArgs,
  MarkReadArgs,
  PatchComputerUseHostArgs,
  PatchModelSelectionArgs,
  PatchDraftArgs,
  RecallEventArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";

const L = logger("ChatThread");
export const CHAT_MESSAGES_PAGE_LIMIT = 50;

type ChatRealtimeSubscription = {
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
};

const patchDraft$ = command(
  async (
    { get, set },
    { threadId, content, structuredPrompt, attachments }: PatchDraftArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: threadId },
        body: {
          draftContent: content,
          draftStructuredPrompt: structuredPrompt,
          draftAttachments: attachments,
        },
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
    { get, set },
    { threadId, modelSelection }: PatchModelSelectionArgs,
    signal: AbortSignal,
  ) => {
    const modelSelectionEventId = crypto.randomUUID();
    const serviceTierEventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      const createdAt = nowDate().toISOString();
      set(registerOptimisticChatThreadEvent$, {
        id: modelSelectionEventId,
        kind: "model_selection_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        title: null,
        selectedModel: modelSelection?.selectedModel ?? null,
        serviceTier: null,
        computerUseHostId: null,
        createdAt,
      } satisfies ChatThreadEvent);
      set(registerOptimisticChatThreadEvent$, {
        id: serviceTierEventId,
        kind: "service_tier_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        title: null,
        selectedModel: null,
        serviceTier:
          modelSelection?.codexServiceTier === "fast" ? "priority" : null,
        computerUseHostId: null,
        createdAt,
      } satisfies ChatThreadEvent);
    }

    const client = get(zeroClient$)(chatThreadModelSelectionContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: {
          model: modelSelection?.selectedModel ?? null,
          codexServiceTier: threadCodexServiceTierFromSelection(modelSelection),
          eventId: modelSelectionEventId,
          serviceTierEventId,
        },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

const patchComputerUseHost$ = command(
  async (
    { get, set },
    { threadId, computerUseHostId }: PatchComputerUseHostArgs,
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "computer_use_host_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        title: null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId,
        createdAt: nowDate().toISOString(),
      } satisfies ChatThreadEvent);
    }
    const client = get(zeroClient$)(chatThreadComputerUseHostContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { computerUseHostId, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

const appendQueuedEvent$ = command(
  async (
    { get },
    {
      threadId,
      agentId,
      content,
      attachments,
      clientEventId,
      chatThreadSortEventId,
      hasTextContent,
      generationTemplate,
      structuredPrompt,
      computerUseHostId,
      runOptions,
      realAgentInPreview,
    }: AppendQueuedEventArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatEventsContract);
    await accept(
      client.send({
        body: {
          agentId,
          prompt: content ?? "",
          threadId,
          hasTextContent,
          clientEventId: clientEventId,
          chatThreadSortEventId,
          generationTemplate,
          ...(structuredPrompt ? { structuredPrompt } : {}),
          ...(runOptions ? { runOptions } : {}),
          ...(realAgentInPreview ? { realAgentInPreview: true } : {}),
          ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
          attachFiles: attachments ?? undefined,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
  },
);

const recallEvent$ = command(
  async (
    { get },
    { threadId, agentId, revokesEventId, clientEventId }: RecallEventArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatEventsContract);
    await accept(
      client.send({
        body: {
          agentId,
          threadId,
          revokesEventId: revokesEventId,
          clientEventId: clientEventId,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
  },
);

export const listEventsAfter$ = command(
  async (
    { get },
    { threadId, sinceSeqId }: ListEventsAfterArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadEventsContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { sinceSeqId, limit: CHAT_MESSAGES_PAGE_LIMIT },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    L.debug("listEventsAfter$", {
      threadId,
      sinceSeqId,
      count: result.body.events.length,
      runEvents: result.body.events.flatMap((event) => {
        if (!event.runId) {
          return [];
        }
        return [
          {
            id: event.id,
            runId: event.runId,
          },
        ];
      }),
    });
    return {
      events: result.body.events.map(canonicalChatEvent),
      hasHistoryBefore: result.body.hasHistoryBefore ?? false,
    };
  },
);

export const listEventsBefore$ = command(
  async (
    { get },
    { threadId, beforeSeqId }: ListEventsBeforeArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadEventsContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { beforeSeqId, limit: 50 },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return {
      events: result.body.events.map(canonicalChatEvent),
      hasHistoryBefore: result.body.hasHistoryBefore ?? false,
    };
  },
);

const cancelRuns$ = command(
  async (
    { get },
    { threadId, agentId, interrupts }: CancelRunsArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatEventsContract);
    L.debug("cancelRun$ start", {
      threadId,
      pendingRunIds: interrupts.map((interrupt) => {
        return interrupt.runId;
      }),
    });
    await Promise.all(
      interrupts.map(async ({ runId, clientEventId }) => {
        await accept(
          client.send({
            body: {
              agentId,
              threadId,
              interruptsRunId: runId,
              clientEventId: clientEventId,
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
    { threadId }: MarkReadArgs,
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
    return result.body.lastReadAt;
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
              topic: `chatThreadAutomationsChanged:${threadId}`,
              loopCommand$: handlers.onAutomationsChanged$,
            },
            {
              topic: `chatThreadArtifactsChanged:${threadId}`,
              loopCommand$: handlers.onArtifactsChanged$,
            },
            {
              topic: `chatThreadWorkflowsChanged:${threadId}`,
              loopCommand$: handlers.onWorkflowsChanged$,
            },
            {
              topic: `chatThreadWorkflowQueueChanged:${threadId}`,
              loopCommand$: handlers.onWorkflowQueueChanged$,
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
            await set(
              setAblyLoop$,
              {
                topic: subscription.topic,
                loopCommand$: subscription.loopCommand$,
                options,
              },
              subscriptionSignal,
            );
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
            await onRejection(
              Promise.resolve(set(handlers.onSubscribed$, subscriptionSignal)),
              async () => {
                subscriptionScope.abort();
                await Promise.allSettled(subscriptionPromises);
                signal.throwIfAborted();
              },
            );
            subscriptionSignal.throwIfAborted();
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

export function createRemoteChatThreadDataSource(threadId: string) {
  const subscribeRealtime$ = createSubscribeRealtime();
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const threadDraft$ = computed(async (get) => {
    if (get(optimisticCreateUnsettled$)) {
      return null;
    }
    const client = get(zeroClient$)(chatThreadDraftContract);
    const result = await accept(
      client.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (result.status === 404) {
      return null;
    }
    return result.body;
  });

  return {
    threadDraft$,
    patchDraft$,
    patchModelSelection$,
    patchComputerUseHost$,
    appendQueuedEvent$,
    recallEvent$,
    listEventsAfter$,
    listEventsBefore$,
    cancelRuns$,
    markRead$,
    subscribeRealtime$,
  };
}
