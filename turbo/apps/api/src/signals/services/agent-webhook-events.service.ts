import { command, type Command } from "ccstate";

import { eventConsumerPayloadState$ } from "../../lib/event-consumer/route";
import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { eventDeliveryUnavailable } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { publishRunChangedForUserSafely } from "../external/realtime";
import { refreshAgentPhoneTypingEvents$ } from "./agent-event-consumer-agentphone-typing.service";
import { ingestAxiomEvents } from "./agent-event-consumer-axiom.service";
import { processChatAssistantEvents$ } from "./agent-event-consumer-chat-assistant.service";
import { refreshTelegramTypingEvents$ } from "./agent-event-consumer-telegram-typing.service";
import { settle, tapError } from "../utils";

const L = logger("webhook:events");

interface ConsumerResult {
  readonly status: number;
}

type ConsumerCommandResult = ConsumerResult | Promise<ConsumerResult>;
type ConsumerCommand = Command<ConsumerCommandResult, [AbortSignal]>;

interface AgentEventsBody {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
}

interface ReceiveAgentEventsParams {
  readonly auth: SandboxAuth;
  readonly body: AgentEventsBody;
}

interface DispatchableConsumer {
  readonly name: string;
  readonly command$: ConsumerCommand;
  readonly eventTypes?: readonly string[];
}

interface PreparedConsumer {
  readonly name: string;
  readonly command$: ConsumerCommand;
  readonly events: readonly AgentEvent[];
}

const OPTIONAL_EVENT_CONSUMERS: readonly DispatchableConsumer[] = [
  {
    name: "chat-assistant",
    command$: processChatAssistantEvents$,
  },
  {
    name: "telegram-typing",
    command$: refreshTelegramTypingEvents$,
  },
  {
    name: "agentphone-typing",
    command$: refreshAgentPhoneTypingEvents$,
  },
];

function eventRange(events: readonly AgentEvent[]): {
  readonly firstSequence: number;
  readonly lastSequence: number;
} {
  return {
    firstSequence: events[0]!.sequenceNumber,
    lastSequence: events[events.length - 1]!.sequenceNumber,
  };
}

function immutableEventPayload(
  auth: SandboxAuth,
  body: AgentEventsBody,
): EventConsumerPayload {
  return Object.freeze({
    runId: body.runId,
    events: Object.freeze([...body.events]),
    context: Object.freeze({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  });
}

const runOptionalEventConsumer$ = command(
  async (
    { set },
    params: {
      readonly consumer: PreparedConsumer;
      readonly payload: EventConsumerPayload;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const range = eventRange(params.consumer.events);
    set(
      eventConsumerPayloadState$,
      Object.freeze({
        ...params.payload,
        events: Object.freeze([...params.consumer.events]),
      }),
    );
    const result = await tapError(
      Promise.resolve(set(params.consumer.command$, signal)),
      (error) => {
        L.error(`Optional event consumer "${params.consumer.name}" failed`, {
          runId: params.payload.runId,
          ...range,
          error,
        });
      },
    );
    signal.throwIfAborted();

    if (result && result.status !== 200) {
      L.error(`Optional event consumer "${params.consumer.name}" failed`, {
        runId: params.payload.runId,
        ...range,
        status: result.status,
      });
    }
  },
);

export const dispatchOptionalAgentEventConsumers$ = command(
  async (
    { set },
    payload: EventConsumerPayload,
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = now();
    const consumers = OPTIONAL_EVENT_CONSUMERS.map(
      (consumer): PreparedConsumer | null => {
        const matchingEvents = consumer.eventTypes
          ? payload.events.filter((event) => {
              return consumer.eventTypes?.includes(event.type) ?? false;
            })
          : payload.events;

        return matchingEvents.length === 0
          ? null
          : {
              name: consumer.name,
              command$: consumer.command$,
              events: matchingEvents,
            };
      },
    ).filter((consumer): consumer is PreparedConsumer => {
      return consumer !== null;
    });

    for (const consumer of consumers) {
      await set(runOptionalEventConsumer$, { consumer, payload }, signal);
    }

    const range = eventRange(payload.events);
    await publishRunChangedForUserSafely(
      payload.context.userId,
      payload.runId,
      range,
    );
    signal.throwIfAborted();
    L.debug(
      `Optional events ${range.firstSequence}-${range.lastSequence} dispatched for run ${payload.runId} (${now() - startedAt}ms)`,
    );
  },
);

export const receiveAgentEvents$ = command(
  async (_context, params: ReceiveAgentEventsParams, signal: AbortSignal) => {
    const payload = immutableEventPayload(params.auth, params.body);
    const range = eventRange(payload.events);
    const startedAt = now();

    L.debug(
      `Delivering events ${range.firstSequence}-${range.lastSequence} for run ${payload.runId}`,
    );
    const ingestResult = await settle(ingestAxiomEvents(payload, signal));
    signal.throwIfAborted();
    if (!ingestResult.ok) {
      L.error("Required Axiom event delivery failed", {
        runId: payload.runId,
        ...range,
        error: ingestResult.error,
      });
      return {
        response: eventDeliveryUnavailable(
          "Agent event delivery is temporarily unavailable",
        ),
      };
    }

    L.debug(
      `Events ${range.firstSequence}-${range.lastSequence} accepted for run ${payload.runId} (${now() - startedAt}ms)`,
    );
    return {
      response: {
        status: 200 as const,
        body: {
          received: payload.events.length,
          ...range,
        },
      },
      acceptedPayload: payload,
    };
  },
);
