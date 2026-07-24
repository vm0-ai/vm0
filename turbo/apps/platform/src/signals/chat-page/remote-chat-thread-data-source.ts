import { command, computed, state, type Command } from "ccstate";
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
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { threadCodexServiceTierFromSelection } from "./model-selection-request.ts";
import { setAblyLoop$, setAblyPayloadLoop$ } from "../realtime.ts";
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
import type { ChatThread } from "../agent-chat.ts";
import type {
  CancelRunsArgs,
  AppendQueuedEventArgs,
  GetEventArgs,
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
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "model_selection_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        title: null,
        selectedModel: modelSelection?.selectedModel ?? null,
        createdAt: nowDate().toISOString(),
      } satisfies ChatThreadEvent);
    }

    const client = get(zeroClient$)(chatThreadModelSelectionContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: {
          model: modelSelection?.selectedModel ?? null,
          codexServiceTier: threadCodexServiceTierFromSelection(modelSelection),
          eventId,
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
    const eventClient = get(zeroClient$)(chatThreadEventsContract);
    const eventResult = await accept(
      eventClient.get({
        params: { threadId, eventId: clientEventId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return canonicalChatEvent(eventResult.body);
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
    const eventClient = get(zeroClient$)(chatThreadEventsContract);
    const eventResult = await accept(
      eventClient.get({
        params: { threadId, eventId: clientEventId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return canonicalChatEvent(eventResult.body);
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
        query: { sinceSeqId, limit: 50 },
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

const getEvent$ = command(
  async (
    { get },
    { threadId, eventId }: GetEventArgs,
    signal: AbortSignal,
  ): Promise<ChatEvent | null> => {
    const client = get(zeroClient$)(chatThreadEventsContract);
    const result = await accept(
      client.get({
        params: { threadId, eventId },
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    if (result.status === 404) {
      return null;
    }
    return canonicalChatEvent(result.body);
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
              kind: "loop",
              topic: `chatThreadDetailChanged:${threadId}`,
              loopCommand$: handlers.onThreadDetailChanged$,
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
            {
              kind: "loop",
              topic: `chatThreadArtifactsChanged:${threadId}`,
              loopCommand$: handlers.onArtifactsChanged$,
            },
            {
              kind: "loop",
              topic: `chatThreadWorkflowsChanged:${threadId}`,
              loopCommand$: handlers.onWorkflowsChanged$,
            },
            {
              kind: "loop",
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
  const reloadCounter$ = state(0);
  const subscribeRealtime$ = createSubscribeRealtime();
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const remoteThreadDetail$ = computed(
    async (get): Promise<ChatThread | null> => {
      if (get(optimisticCreateUnsettled$)) {
        return null;
      }
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
        lastReadAt: body.lastReadAt,
        computerUseHostId: body.computerUseHostId ?? null,
        codexServiceTier: body.codexServiceTier ?? null,
      };
    },
  );

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

  const reloadThread$ = command(({ set }) => {
    set(reloadCounter$, (v) => {
      return v + 1;
    });
  });

  return {
    remoteThreadDetail$,
    threadDraft$,
    reloadThread$,
    patchDraft$,
    patchModelSelection$,
    patchComputerUseHost$,
    appendQueuedEvent$,
    recallEvent$,
    listEventsAfter$,
    listEventsBefore$,
    getEvent$,
    cancelRuns$,
    markRead$,
    subscribeRealtime$,
  };
}
