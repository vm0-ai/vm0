import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  chatThreadArtifactsContract,
  type AttachFile,
  type ChatPromptEvent,
  type ChatRunOptionsRequest,
  type ChatThreadArtifactRun,
  type GenerationTemplateRequest,
  type UserMessageDocument,
  type ChatEvent as PersistedChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatEvent } from "./chat-event-types.ts";
import type { ChatThreadMessageSignals } from "./chat-thread-signals.ts";
import {
  listEventsAfter$,
  listEventsBefore$,
  markChatThreadRead$,
} from "./remote-chat-event-data-source.ts";
import { createChatEventPipeline } from "./create-chat-thread.ts";
import { nowDate } from "../../lib/time.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { reloadBillingStatus$ } from "../zero-page/billing.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  optimisticChatThreadCreateUnsettled,
  touchOptimisticChatThreadSort$,
} from "./chat-thread-event-sourcing.ts";
import { registerActiveChatEventSignals$ } from "./chat-event-signal-registry.ts";
import type { OptimisticChatEventInput } from "./optimistic-chat-events.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventSignals");

function createArtifacts(threadId: string) {
  const internalArtifactsReload$ = state(0);
  const artifacts$ = computed(async (get): Promise<ChatThreadArtifactRun[]> => {
    get(internalArtifactsReload$);
    const client = get(zeroClient$)(chatThreadArtifactsContract);
    const result = await accept(client.list({ params: { threadId } }), [200]);
    return result.body.runs;
  });

  const reloadArtifacts$ = command(({ set }) => {
    set(internalArtifactsReload$, (version) => {
      return version + 1;
    });
  });

  return { artifacts$, reloadArtifacts$ };
}

function createArtifactPreviewImageUrls(
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>,
): Computed<Promise<ReadonlyMap<string, string>>> {
  return computed(async (get) => {
    const runs = await get(artifacts$);
    const previewImageUrlsByUrl = new Map<string, string>();
    for (const run of runs) {
      for (const file of run.files) {
        if (!file.previewImageUrl) {
          continue;
        }
        previewImageUrlsByUrl.set(file.url, file.previewImageUrl);
        if (file.aliasUrl) {
          previewImageUrlsByUrl.set(file.aliasUrl, file.previewImageUrl);
        }
      }
    }
    return previewImageUrlsByUrl;
  });
}

export interface ChatEventDataSource {
  readonly listEventsAfter$: typeof listEventsAfter$;
  readonly listEventsBefore$: typeof listEventsBefore$;
  readonly markRead$: typeof markChatThreadRead$;
}

export interface SendInputChatEvent {
  readonly kind: "input";
  readonly delivery: "run" | "queue";
  readonly agentId: string;
  readonly prompt: string;
  readonly hasTextContent: boolean;
  readonly attachFiles: AttachFile[] | undefined;
  readonly attachments: ChatPromptEvent["attachFiles"];
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly userMessage: UserMessageDocument;
  readonly runOptions?: ChatRunOptionsRequest;
  readonly realAgentInPreview?: boolean;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly revokesEventId?: string;
}

export interface SendRevokeChatEvent {
  readonly kind: "revoke";
  readonly agentId: string;
  readonly revokesEventId: string;
}

export interface SendInterruptChatEvent {
  readonly kind: "interrupt";
  readonly agentId: string;
  readonly interruptsRunId: string;
}

export interface SendSteerChatEvent {
  readonly kind: "steer";
  readonly agentId: string;
  readonly runId: string;
  readonly eventId: string;
  readonly triggerSource: ChatPromptEvent["triggerSource"];
  readonly userMessage: UserMessageDocument;
}

export type SendChatEventInput =
  | SendInputChatEvent
  | SendRevokeChatEvent
  | SendInterruptChatEvent
  | SendSteerChatEvent;

export interface SendChatEventResult {
  readonly runId: string | null;
}

export type OptimisticScrollBehavior = "preserve" | "bottom";
export type AppendOptimisticEventCommand = Command<
  Promise<void>,
  [OptimisticChatEventInput, OptimisticScrollBehavior, AbortSignal]
>;

interface SendChatEventDependencies {
  readonly threadId: string;
  readonly appendOptimisticEvent$: AppendOptimisticEventCommand;
  readonly syncRemoteEvents$: Command<Promise<void>, [AbortSignal]>;
}

function createSendInputChatEvent({
  threadId,
  appendOptimisticEvent$,
  syncRemoteEvents$,
}: SendChatEventDependencies): Command<
  Promise<SendChatEventResult>,
  [SendInputChatEvent, AbortSignal]
> {
  return command(
    async ({ get, set }, input: SendInputChatEvent, signal: AbortSignal) => {
      const clientEventId = crypto.randomUUID();
      const createdAt = nowDate().toISOString();
      const chatThreadSortEventId = crypto.randomUUID();
      set(touchOptimisticChatThreadSort$, {
        id: chatThreadSortEventId,
        threadId,
        agentId: input.agentId,
        createdAt,
      });
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          optimisticUserMessageAssociation: input.delivery,
          event: {
            id: clientEventId,
            threadId,
            eventType: "input.prompt",
            content: null,
            attachFiles: input.attachments,
            generationTemplate: input.generationTemplate,
            userMessage: input.userMessage,
            ...(input.revokesEventId === undefined
              ? {}
              : { revokesEventId: input.revokesEventId }),
            createdAt,
          },
        },
        "bottom",
        signal,
      );
      signal.throwIfAborted();
      const result = await sendChatEvent(
        get(zeroClient$),
        {
          agentId: input.agentId,
          prompt: input.prompt,
          threadId,
          hasTextContent: input.hasTextContent,
          clientEventId,
          chatThreadSortEventId,
          ...(input.runOptions === undefined
            ? {}
            : { runOptions: input.runOptions }),
          ...(input.realAgentInPreview === true
            ? { realAgentInPreview: true }
            : {}),
          generationTemplate: input.generationTemplate,
          userMessage: input.userMessage,
          ...(input.computerUseHostId === undefined
            ? {}
            : { computerUseHostId: input.computerUseHostId }),
          ...(input.cloudBrowserEnabled === undefined
            ? {}
            : { cloudBrowserEnabled: input.cloudBrowserEnabled }),
          attachFiles: input.attachFiles,
          ...(input.revokesEventId === undefined
            ? {}
            : { revokesEventId: input.revokesEventId }),
        },
        signal,
      );
      signal.throwIfAborted();
      if (input.delivery === "run" && result.runId === null) {
        set(reloadBillingStatus$);
        await set(syncRemoteEvents$, signal);
        signal.throwIfAborted();
      }
      return { runId: result.runId };
    },
  );
}

function createSendRevokeChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<SendChatEventResult>,
  [SendRevokeChatEvent, AbortSignal]
> {
  return command(
    async ({ get, set }, input: SendRevokeChatEvent, signal: AbortSignal) => {
      const clientEventId = crypto.randomUUID();
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          event: {
            id: clientEventId,
            threadId,
            eventType: "control.revoke",
            content: null,
            revokesEventId: input.revokesEventId,
            createdAt: nowDate().toISOString(),
          },
        },
        "preserve",
        signal,
      );
      signal.throwIfAborted();
      const result = await sendChatEvent(
        get(zeroClient$),
        {
          agentId: input.agentId,
          threadId,
          revokesEventId: input.revokesEventId,
          clientEventId,
        },
        signal,
      );
      return { runId: result.runId };
    },
  );
}

function createSendInterruptChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<SendChatEventResult>,
  [SendInterruptChatEvent, AbortSignal]
> {
  return command(
    async (
      { get, set },
      input: SendInterruptChatEvent,
      signal: AbortSignal,
    ) => {
      const clientEventId = crypto.randomUUID();
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          event: {
            id: clientEventId,
            threadId,
            eventType: "control.interrupt",
            content: null,
            interruptsRunId: input.interruptsRunId,
            createdAt: nowDate().toISOString(),
          },
        },
        "preserve",
        signal,
      );
      signal.throwIfAborted();
      const result = await sendChatEvent(
        get(zeroClient$),
        {
          agentId: input.agentId,
          threadId,
          interruptsRunId: input.interruptsRunId,
          clientEventId,
        },
        signal,
      );
      return { runId: result.runId };
    },
  );
}

function createSendSteerChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<SendChatEventResult>,
  [SendSteerChatEvent, AbortSignal]
> {
  return command(
    async ({ get, set }, input: SendSteerChatEvent, signal: AbortSignal) => {
      const clientEventId = crypto.randomUUID();
      const result = await sendChatEvent(
        get(zeroClient$),
        {
          agentId: input.agentId,
          threadId,
          steersRunId: input.runId,
          steersEventId: input.eventId,
          clientEventId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.runId !== input.runId) {
        throw new Error("Steered chat event was associated with another run");
      }
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          optimisticUserMessageAssociation: "run",
          event: {
            id: clientEventId,
            threadId,
            eventType: "input.prompt",
            content: null,
            runId: input.runId,
            revokesEventId: input.eventId,
            triggerSource: input.triggerSource,
            userMessage: input.userMessage,
            createdAt: result.createdAt ?? nowDate().toISOString(),
          },
        },
        "preserve",
        signal,
      );
      signal.throwIfAborted();
      return { runId: result.runId };
    },
  );
}

function createSendChatEvent(
  dependencies: SendChatEventDependencies,
): Command<Promise<SendChatEventResult>, [SendChatEventInput, AbortSignal]> {
  const sendInput$ = createSendInputChatEvent(dependencies);
  const sendRevoke$ = createSendRevokeChatEvent(dependencies);
  const sendInterrupt$ = createSendInterruptChatEvent(dependencies);
  const sendSteer$ = createSendSteerChatEvent(dependencies);
  return command(
    async ({ set }, input: SendChatEventInput, signal: AbortSignal) => {
      switch (input.kind) {
        case "input": {
          return await set(sendInput$, input, signal);
        }
        case "revoke": {
          return await set(sendRevoke$, input, signal);
        }
        case "interrupt": {
          return await set(sendInterrupt$, input, signal);
        }
        case "steer": {
          return await set(sendSteer$, input, signal);
        }
      }
    },
  );
}

function createChatEventSetup({
  threadId,
  initialRemoteEventsResolved$,
  initializeIndexedDbEvents$,
  mergePersistentEvents$,
  syncRemoteEvents$,
}: {
  readonly threadId: string;
  readonly initialRemoteEventsResolved$: State<boolean>;
  readonly initializeIndexedDbEvents$: Command<Promise<void>, [AbortSignal]>;
  readonly mergePersistentEvents$: Command<
    Promise<void>,
    [PersistedChatEvent[], AbortSignal]
  >;
  readonly syncRemoteEvents$: Command<Promise<void>, [AbortSignal]>;
}): Command<Promise<void>, [AbortSignal]> {
  const receive$ = command(
    async (
      { set },
      events: readonly PersistedChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      L.debug("receive synced chat events", {
        threadId,
        count: events.length,
      });
      await set(mergePersistentEvents$, [...events], signal);
      signal.throwIfAborted();
    },
  );
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(registerActiveChatEventSignals$, threadId, receive$, signal);
    await set(initializeIndexedDbEvents$, signal);
    signal.throwIfAborted();
    if (get(optimisticCreateUnsettled$)) {
      set(initialRemoteEventsResolved$, true);
      return;
    }
    await set(syncRemoteEvents$, signal);
  });
}

export interface ChatEventSignals {
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
}

export interface CreatedChatEventSignals {
  readonly signals: ChatEventSignals;
  readonly threadMessages: ChatThreadMessageSignals;
}

export function createChatEventSignals(
  threadId: string,
): CreatedChatEventSignals {
  const dataSource: ChatEventDataSource = {
    listEventsAfter$,
    listEventsBefore$,
    markRead$: markChatThreadRead$,
  };
  const artifact = createArtifacts(threadId);
  const previewImageUrlsByUrl$ = createArtifactPreviewImageUrls(
    artifact.artifacts$,
  );
  const events = createChatEventPipeline({
    threadId,
    dataSource,
    previewImageUrlsByUrl$,
  });
  const sendEvent$ = createSendChatEvent({
    threadId,
    appendOptimisticEvent$: events.appendOptimisticEvent$,
    syncRemoteEvents$: events.syncRemoteEvents$,
  });
  const setup$ = createChatEventSetup({
    threadId,
    initialRemoteEventsResolved$: events.initialRemoteEventsResolved$,
    initializeIndexedDbEvents$: events.initializeIndexedDbEvents$,
    mergePersistentEvents$: events.mergePersistentEvents$,
    syncRemoteEvents$: events.syncRemoteEvents$,
  });
  return {
    signals: {
      chatEvents$: events.chatEvents$,
      setup$,
      sendEvent$,
    },
    threadMessages: {
      scroll: events.scroll,
      sidebar: events.sidebar,
      latestRunFinishCreatedAt$: events.latestRunFinishCreatedAt$,
      latestAssistantTextCreatedAt$: events.latestAssistantTextCreatedAt$,
      visibleRenderedChatGroups$: events.visibleRenderedChatGroups$,
      visibleRenderedChatGroupsReady$: events.visibleRenderedChatGroupsReady$,
      chatSkeletonVisible$: events.chatSkeletonVisible$,
      eventImageGroups$: events.eventImageGroups$,
      artifactSignalsForUrl: events.artifactSignalsForUrl,
      agentReferenceSignalsForId: events.agentReferenceSignalsForId,
      mailDraftCardSignalsById$: events.mailDraftCardSignalsById$,
      reloadMailDrafts$: events.reloadMailDrafts$,
      browserSessionSignals: events.browserSessionSignals,
      subscribeBrowserSessions$: events.subscribeBrowserSessions$,
      hasEvents$: events.hasEvents$,
      thinkingIndicatorMode$: events.thinkingIndicatorMode$,
      thinkingEventId$: events.thinkingEventId$,
      thinkingText$: events.thinkingText$,
      recommendedFollowupSource$: events.recommendedFollowupSource$,
      historyBackfillPending$: events.historyBackfillPending$,
      donePhrase$: events.donePhrase$,
      loadMoreRenderedChatGroups$: events.loadMoreRenderedChatGroups$,
      resetRenderedChatGroupsIfAtBottom$:
        events.resetRenderedChatGroupsIfAtBottom$,
      ...artifact,
    },
  };
}
