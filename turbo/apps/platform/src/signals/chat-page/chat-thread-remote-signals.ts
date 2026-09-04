import { command, computed, state, type Command } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadDraftSchema,
  chatThreadComputerUseHostContract,
  chatThreadImageModelContract,
  chatThreadModelSelectionContract,
  chatThreadVideoModelContract,
  type DraftVoice,
  type PersistedAttachment,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { threadCodexServiceTierFromSelection } from "./model-selection-request.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createDeferredPromise } from "../utils.ts";
import { reloadSidebarDraftThreads$ } from "./sidebar-draft-threads.ts";
import {
  chatThreadMetaMap$,
  optimisticChatThreadCreateUnsettled,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";
import type { OptimisticChatThreadEvent } from "./chat-thread-event-types.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

interface ChatThreadRealtimeHandlers {
  readonly onThreadDetailChanged$: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly onAutomationsChanged$: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly onArtifactsChanged$: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly onWorkflowsChanged$: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly onSubscribed$?: Command<Promise<void> | void, [AbortSignal]>;
}

interface PatchDraftArgs {
  readonly threadId: string;
  readonly userMessage: UserMessageInputDocument | null;
  readonly draftVoice: DraftVoice | null;
  readonly attachments: PersistedAttachment[] | null;
}

interface PatchModelSelectionArgs {
  readonly threadId: string;
  readonly modelSelection: ModelProviderSelection | null;
}

interface PatchComputerUseHostArgs {
  readonly threadId: string;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}

interface PatchVideoModelArgs {
  readonly threadId: string;
  readonly videoModel: VideoModel | null;
}

interface PatchImageModelArgs {
  readonly threadId: string;
  readonly imageModel: ImageModel | null;
}

interface SubscribeRealtimeArgs {
  readonly threadId: string;
  readonly handlers: ChatThreadRealtimeHandlers;
}

type ChatRealtimeSubscription = {
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
};

export const patchChatThreadDraft$ = command(
  async (
    { get, set },
    { threadId, userMessage, draftVoice, attachments }: PatchDraftArgs,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(chatThreadByIdContract);
    await accept(
      client.patch({
        params: { id: threadId },
        body: {
          draftUserMessage: userMessage,
          ...(draftVoice ? { draftVoice } : {}),
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

export const patchChatThreadModelSelection$ = command(
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
        selectedVideoModel: null,
        selectedImageModel: null,
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
        selectedVideoModel: null,
        selectedImageModel: null,
        createdAt,
      } satisfies OptimisticChatThreadEvent);
    }

    const client = get(apiClient$)(chatThreadModelSelectionContract);
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

export const patchChatThreadComputerUseHost$ = command(
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
        selectedVideoModel: null,
        selectedImageModel: null,
        createdAt: nowDate().toISOString(),
      } satisfies OptimisticChatThreadEvent);
    }
    const client = get(apiClient$)(chatThreadComputerUseHostContract);
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

export const patchChatThreadVideoModel$ = command(
  async (
    { get, set },
    { threadId, videoModel }: PatchVideoModelArgs,
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "video_model_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        title: null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
        selectedVideoModel: videoModel,
        selectedImageModel: null,
        createdAt: nowDate().toISOString(),
      } satisfies OptimisticChatThreadEvent);
    }
    const client = get(apiClient$)(chatThreadVideoModelContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { model: videoModel, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

export const patchChatThreadImageModel$ = command(
  async (
    { get, set },
    { threadId, imageModel }: PatchImageModelArgs,
    signal: AbortSignal,
  ) => {
    const eventId = crypto.randomUUID();
    const threadMeta = get(chatThreadMetaMap$).get(threadId);
    if (threadMeta) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "image_model_updated",
        chatThreadId: threadId,
        agentId: threadMeta.agentId,
        title: null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
        selectedVideoModel: null,
        selectedImageModel: imageModel,
        createdAt: nowDate().toISOString(),
      } satisfies OptimisticChatThreadEvent);
    }
    const client = get(apiClient$)(chatThreadImageModelContract);
    await accept(
      client.update({
        params: { id: threadId },
        body: { model: imageModel, eventId },
        fetchOptions: { signal },
      }),
      [204],
    );
  },
);

export const subscribeChatThreadRealtime$ = command(
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

export function createCancellationRecoverySignals(threadId: string) {
  const threadDetailReloadCounter$ = state(0);
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  const cancellationRecoveryPending$ = computed(async (get) => {
    if (get(optimisticCreateUnsettled$)) {
      return false;
    }
    get(threadDetailReloadCounter$);
    const client = get(apiClient$)(chatThreadByIdContract);
    const result = await accept(
      client.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (result.status === 404) {
      return false;
    }
    return result.body.cancellationRecoveryPending;
  });

  const reload$ = command(({ set }) => {
    set(threadDetailReloadCounter$, (value) => {
      return value + 1;
    });
  });

  return { pending$: cancellationRecoveryPending$, reload$ };
}

export function createRemoteChatThreadDraft(threadId: string) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return computed(async (get) => {
    if (get(optimisticCreateUnsettled$)) {
      return null;
    }
    const client = get(apiClient$)(chatThreadDraftContract);
    const result = await accept(
      client.get({ params: { id: threadId } }),
      [200, 404],
    );
    if (result.status === 404) {
      return null;
    }
    return chatThreadDraftSchema.parse(result.body);
  });
}
