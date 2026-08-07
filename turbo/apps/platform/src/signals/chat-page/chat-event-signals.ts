import {
  command,
  computed,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import type {
  ChatRunOptionsRequest,
  UserMessageInputDocument,
  ChatEvent as PersistedChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  listEventsAfter$,
  listEventsBefore$,
} from "./remote-chat-event-data-source.ts";
import {
  createChatEventStorageSignals,
  type AppendOptimisticEventCommand,
  type ChatEventDataSource,
} from "./chat-event-storage-signals.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import { reloadBillingStatus$ } from "../zero-page/billing.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  optimisticChatThreadCreateUnsettled,
  touchOptimisticChatThreadSort$,
} from "./chat-thread-event-sourcing.ts";
import { registerActiveChatEventSignals$ } from "./chat-event-signal-registry.ts";
import { logger } from "../log.ts";

const L = logger("ChatEventSignals");

export interface SendInputChatEvent {
  readonly kind: "input";
  readonly delivery: "run" | "queue";
  readonly agentId: string;
  readonly prompt: string;
  readonly hasTextContent: boolean;
  readonly userMessage: UserMessageInputDocument;
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

export interface SendBrowserLifecycleChatEvent {
  readonly kind: "browser-lifecycle";
  readonly eventId: string;
  readonly eventType: "browser.open" | "browser.close";
}

export type SendChatEventInput =
  | SendInputChatEvent
  | SendRevokeChatEvent
  | SendInterruptChatEvent
  | SendBrowserLifecycleChatEvent;

export interface SendChatEventResult {
  readonly runId: string | null;
}

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
            userMessage: input.userMessage,
            ...(input.revokesEventId === undefined
              ? {}
              : { revokesEventId: input.revokesEventId }),
            createdAt,
          },
        },
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
          userMessage: input.userMessage,
          ...(input.computerUseHostId === undefined
            ? {}
            : { computerUseHostId: input.computerUseHostId }),
          ...(input.cloudBrowserEnabled === undefined
            ? {}
            : { cloudBrowserEnabled: input.cloudBrowserEnabled }),
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

function createSendBrowserLifecycleChatEvent({
  threadId,
  appendOptimisticEvent$,
}: SendChatEventDependencies): Command<
  Promise<SendChatEventResult>,
  [SendBrowserLifecycleChatEvent, AbortSignal]
> {
  return command(
    async (
      { set },
      input: SendBrowserLifecycleChatEvent,
      signal: AbortSignal,
    ): Promise<SendChatEventResult> => {
      await set(
        appendOptimisticEvent$,
        {
          threadId,
          event: {
            id: input.eventId,
            threadId,
            eventType: input.eventType,
            content: null,
            createdAt: nowDate().toISOString(),
          },
        },
        signal,
      );
      return { runId: null };
    },
  );
}

function createSendChatEvent(
  dependencies: SendChatEventDependencies,
): Command<Promise<SendChatEventResult>, [SendChatEventInput, AbortSignal]> {
  const sendInput$ = createSendInputChatEvent(dependencies);
  const sendRevoke$ = createSendRevokeChatEvent(dependencies);
  const sendInterrupt$ = createSendInterruptChatEvent(dependencies);
  const sendBrowserLifecycle$ =
    createSendBrowserLifecycleChatEvent(dependencies);
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
        case "browser-lifecycle": {
          return await set(sendBrowserLifecycle$, input, signal);
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
}): {
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
} {
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

  const setup$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(registerActiveChatEventSignals$, threadId, receive$, signal);
      await set(initializeIndexedDbEvents$, signal);
      signal.throwIfAborted();
    },
  );
  const catchUp$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(optimisticCreateUnsettled$)) {
        set(initialRemoteEventsResolved$, true);
        return;
      }
      await set(syncRemoteEvents$, signal);
    },
  );

  return { setup$, catchUp$ };
}

export interface ChatEventSignals {
  readonly threadId: string;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly hasOptimisticUserMessage$: Computed<boolean>;
  readonly initialRemoteEventsResolved$: Computed<boolean>;
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
  readonly sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
}

export function createChatEventSignals(threadId: string): ChatEventSignals {
  const dataSource: ChatEventDataSource = {
    listEventsAfter$,
    listEventsBefore$,
  };
  const events = createChatEventStorageSignals({
    threadId,
    dataSource,
  });
  const sendEvent$ = createSendChatEvent({
    threadId,
    appendOptimisticEvent$: events.appendOptimisticEvent$,
    syncRemoteEvents$: events.syncRemoteEvents$,
  });
  const setup = createChatEventSetup({
    threadId,
    initialRemoteEventsResolved$: events.initialRemoteEventsResolved$,
    initializeIndexedDbEvents$: events.initializeIndexedDbEvents$,
    mergePersistentEvents$: events.mergePersistentEvents$,
    syncRemoteEvents$: events.syncRemoteEvents$,
  });
  const initialRemoteEventsResolved$ = computed((get): boolean => {
    return get(events.initialRemoteEventsResolved$);
  });
  return {
    threadId,
    chatEvents$: events.chatEvents$,
    hasOptimisticUserMessage$: events.hasOptimisticUserMessage$,
    initialRemoteEventsResolved$,
    ...setup,
    sendEvent$,
  };
}
