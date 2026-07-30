import { command, computed, type Command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadDraftSchema,
  chatThreadMarkReadContract,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { threadCodexServiceTierFromSelection } from "./model-selection-request.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createDeferredPromise } from "../utils.ts";
import { logger } from "../log.ts";
import { reloadSidebarDraftThreads$ } from "./sidebar-draft-threads.ts";
import {
  applyUnreadSnapshot$,
  recordOptimisticReadMark$,
} from "./sidebar-unread-threads.ts";
import { listChatEvents, sendChatEvent } from "./chat-event-api.ts";
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
import type { OptimisticChatThreadEvent } from "./chat-thread-event-types.ts";

const L = logger("ChatThread");
export const CHAT_EVENTS_PAGE_LIMIT = 50;

type ChatRealtimeSubscription = {
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
};

const patchDraft$ = command(
  async (
    { get, set },
    { threadId, content, userMessage, attachments }: PatchDraftArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: threadId },
        body: {
          draftContent: content,
          draftUserMessage: userMessage,
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
        cloudBrowserEnabled: false,
        createdAt,
      } satisfies OptimisticChatThreadEvent);
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
        cloudBrowserEnabled: false,
        createdAt,
      } satisfies OptimisticChatThreadEvent);
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
    {
      threadId,
      computerUseHostId,
      cloudBrowserEnabled,
    }: PatchComputerUseHostArgs,
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
        cloudBrowserEnabled,
        createdAt: nowDate().toISOString(),
      } satisfies OptimisticChatThreadEvent);
    }
    const client = get(zeroClient$)(chatThreadComputerUseHostContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { computerUseHostId, cloudBrowserEnabled, eventId },
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
      userMessage,
      computerUseHostId,
      cloudBrowserEnabled,
      runOptions,
      realAgentInPreview,
    }: AppendQueuedEventArgs,
    signal: AbortSignal,
  ) => {
    await sendChatEvent(
      get(zeroClient$),
      {
        agentId,
        prompt: content ?? "",
        threadId,
        hasTextContent,
        clientEventId: clientEventId,
        chatThreadSortEventId,
        generationTemplate,
        userMessage,
        ...(runOptions ? { runOptions } : {}),
        ...(realAgentInPreview ? { realAgentInPreview: true } : {}),
        ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
        ...(cloudBrowserEnabled === undefined ? {} : { cloudBrowserEnabled }),
        attachFiles: attachments ?? undefined,
      },
      signal,
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
    await sendChatEvent(
      get(zeroClient$),
      {
        agentId,
        threadId,
        revokesEventId: revokesEventId,
        clientEventId: clientEventId,
      },
      signal,
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
    const events = await listChatEvents(
      get(zeroClient$),
      threadId,
      { sinceSeqId, limit: CHAT_EVENTS_PAGE_LIMIT },
      signal,
    );
    signal.throwIfAborted();
    L.debug("listEventsAfter$", {
      threadId,
      sinceSeqId,
      count: events.length,
      runEvents: events.flatMap((event) => {
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
    return events;
  },
);

const listEventsBefore$ = command(
  async (
    { get },
    { threadId, beforeSeqId }: ListEventsBeforeArgs,
    signal: AbortSignal,
  ) => {
    return await listChatEvents(
      get(zeroClient$),
      threadId,
      { beforeSeqId, limit: CHAT_EVENTS_PAGE_LIMIT },
      signal,
    );
  },
);

const cancelRuns$ = command(
  async (
    { get },
    { threadId, agentId, interrupts }: CancelRunsArgs,
    signal: AbortSignal,
  ) => {
    L.debug("cancelRun$ start", {
      threadId,
      pendingRunIds: interrupts.map((interrupt) => {
        return interrupt.runId;
      }),
    });
    await Promise.all(
      interrupts.map(async ({ runId, clientEventId }) => {
        await sendChatEvent(
          get(zeroClient$),
          {
            agentId,
            threadId,
            interruptsRunId: runId,
            clientEventId: clientEventId,
          },
          signal,
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
  return command(
    async (
      { set },
      { threadId, handlers }: SubscribeRealtimeArgs,
      signal: AbortSignal,
    ) => {
      const ready = createDeferredPromise<void>(signal);
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
      ];

      let pendingSubscriptions = subscriptions.length;
      const markSubscribed = () => {
        pendingSubscriptions -= 1;
        if (pendingSubscriptions === 0 && !ready.settled()) {
          ready.resolve();
        }
      };
      const options = { onSubscribed: markSubscribed };
      const subscription = Promise.all(
        subscriptions.map((subscription) => {
          return set(
            setAblyLoop$,
            {
              topic: subscription.topic,
              loopCommand$: subscription.loopCommand$,
              options,
            },
            signal,
          );
        }),
      );

      await Promise.race([ready.promise, subscription]);
      signal.throwIfAborted();
      if (ready.settled() && handlers.onSubscribed$) {
        await set(handlers.onSubscribed$, signal);
        signal.throwIfAborted();
      }
      await subscription;
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
    return chatThreadDraftSchema.parse(result.body);
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
