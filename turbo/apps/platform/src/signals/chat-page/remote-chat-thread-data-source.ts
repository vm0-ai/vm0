import { command, computed, state, type Command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadDraftSchema,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { threadCodexServiceTierFromSelection } from "./model-selection-request.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createDeferredPromise } from "../utils.ts";
import { reloadSidebarDraftThreads$ } from "./sidebar-draft-threads.ts";
import {
  chatThreadMetaMap$,
  optimisticChatThreadCreateUnsettled,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";
import type {
  PatchComputerUseHostArgs,
  PatchModelSelectionArgs,
  PatchDraftArgs,
  SubscribeRealtimeArgs,
} from "./chat-thread-data-source.ts";
import type { OptimisticChatThreadEvent } from "./chat-thread-event-types.ts";

type ChatRealtimeSubscription = {
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
};

const patchDraft$ = command(
  async (
    { get, set },
    { threadId, userMessage, attachments }: PatchDraftArgs,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: threadId },
        body: {
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
          topic: `chatThreadDetailChanged:${threadId}`,
          loopCommand$: handlers.onThreadDetailChanged$,
        },
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
  const threadDetailReloadCounter$ = state(0);
  const subscribeRealtime$ = createSubscribeRealtime();
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const cancellationRecoveryPending$ = computed(async (get) => {
    if (get(optimisticCreateUnsettled$)) {
      return false;
    }
    get(threadDetailReloadCounter$);
    const client = get(zeroClient$)(chatThreadByIdContract);
    const result = await accept(
      client.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (result.status === 404) {
      return false;
    }
    return result.body.cancellationRecoveryPending ?? false;
  });

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

  const reloadCancellationRecoveryPending$ = command(({ set }) => {
    set(threadDetailReloadCounter$, (value) => {
      return value + 1;
    });
  });

  return {
    cancellationRecoveryPending$,
    threadDraft$,
    reloadCancellationRecoveryPending$,
    patchDraft$,
    patchModelSelection$,
    patchComputerUseHost$,
    subscribeRealtime$,
  };
}
