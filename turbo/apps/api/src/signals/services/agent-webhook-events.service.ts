import { command, type Command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";

import { eventConsumerPayloadState$ } from "../../lib/event-consumer/route";
import type {
  AgentEvent,
  EventConsumerPayload,
  RunEventContext,
} from "../../lib/event-consumer/verify";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { db$ } from "../external/db";
import { publishRunChangedForUserSafely } from "../external/realtime";
import { ingestAxiomEvents$ } from "../routes/internal-event-consumers-axiom";
import { processChatAssistantEvents$ } from "../routes/internal-event-consumers-chat-assistant";
import { settle } from "../utils";

const L = logger("webhook:events");

/**
 * Shape every event-consumer command resolves to. Each route handler returns a
 * richer `{ status, body }` union, but the dispatcher only needs the status to
 * decide success — any non-200 (or a thrown error) is treated as a failure.
 */
interface ConsumerResult {
  readonly status: number;
}

type ConsumerCommand = Command<Promise<ConsumerResult>, [AbortSignal]>;

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
  readonly required?: boolean;
  readonly eventTypes?: readonly string[];
}

interface PreparedConsumer {
  readonly name: string;
  readonly command$: ConsumerCommand;
  readonly required?: boolean;
  readonly events: readonly AgentEvent[];
}

interface DispatchAgentEventConsumersParams {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly context: RunEventContext;
}

const EVENT_CONSUMERS: readonly DispatchableConsumer[] = [
  {
    name: "axiom",
    command$: ingestAxiomEvents$,
    required: true,
  },
  {
    name: "chat-assistant",
    command$: processChatAssistantEvents$,
    eventTypes: ["assistant", "item.completed"],
  },
];

class RequiredEventConsumerDispatchError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`Required event consumer dispatch failed: ${failures.join(", ")}`);
    this.name = "RequiredEventConsumerDispatchError";
    this.failures = failures;
  }
}

function isRequiredEventConsumerDispatchError(
  error: unknown,
): error is RequiredEventConsumerDispatchError {
  return error instanceof RequiredEventConsumerDispatchError;
}

function internalServerError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: {
        message,
        code: "INTERNAL_SERVER_ERROR",
      },
    },
  };
}

/**
 * Invoke one consumer command in-process. The payload is published via
 * `eventConsumerPayloadState$` (the same backing store the HTTP route uses)
 * immediately before the command runs, so the command reads exactly the
 * `{ runId, events, context }` it would have parsed from a signed request.
 *
 * Resolves to `true` on success and `false` on failure — a non-200 status or a
 * thrown error. Failures are logged here; the caller decides whether a failure
 * is fatal (required) or swallowed (optional).
 */
const runEventConsumer$ = command(
  async (
    { set },
    params: {
      readonly consumer: PreparedConsumer;
      readonly payload: EventConsumerPayload;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    set(eventConsumerPayloadState$, params.payload);
    const result = await settle(set(params.consumer.command$, signal), signal);

    if (!result.ok) {
      L.error(`Event consumer "${params.consumer.name}" failed`, {
        runId: params.payload.runId,
        error: result.error,
      });
      return false;
    }
    if (result.value.status !== 200) {
      L.error(`Event consumer "${params.consumer.name}" failed`, {
        runId: params.payload.runId,
        status: result.value.status,
      });
      return false;
    }
    return true;
  },
);

const dispatchAgentEventConsumers$ = command(
  async (
    { set },
    params: DispatchAgentEventConsumersParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const context = params.context;
    const consumers = EVENT_CONSUMERS.map(
      (consumer): PreparedConsumer | null => {
        const matchingEvents = consumer.eventTypes
          ? params.events.filter((event) => {
              return consumer.eventTypes?.includes(event.type) ?? false;
            })
          : params.events;

        if (matchingEvents.length === 0) {
          return null;
        }

        return {
          name: consumer.name,
          command$: consumer.command$,
          required: consumer.required,
          events: matchingEvents,
        };
      },
    ).filter((consumer): consumer is PreparedConsumer => {
      return consumer !== null;
    });

    const requiredConsumers = consumers.filter((consumer) => {
      return consumer.required;
    });
    const optionalConsumers = consumers.filter((consumer) => {
      return !consumer.required;
    });

    const requiredFailures: string[] = [];
    for (const consumer of requiredConsumers) {
      const ok = await set(
        runEventConsumer$,
        {
          consumer,
          payload: { runId: params.runId, events: consumer.events, context },
        },
        signal,
      );
      if (!ok) {
        requiredFailures.push(consumer.name);
      }
    }

    if (requiredFailures.length > 0) {
      throw new RequiredEventConsumerDispatchError(requiredFailures);
    }

    for (const consumer of optionalConsumers) {
      await set(
        runEventConsumer$,
        {
          consumer,
          payload: { runId: params.runId, events: consumer.events, context },
        },
        signal,
      );
    }
  },
);

export const receiveAgentEvents$ = command(
  async (
    { get, set },
    params: ReceiveAgentEventsParams,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [run] = await db
      .select({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.body.runId),
          eq(agentRuns.userId, params.auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!run) {
      return notFound("Agent run not found");
    }

    const firstSequence = params.body.events[0]!.sequenceNumber;
    const lastSequence =
      params.body.events[params.body.events.length - 1]!.sequenceNumber;

    L.debug(
      `Dispatching events ${firstSequence}-${lastSequence} to consumers for run ${params.body.runId}`,
    );
    const startedAt = now();
    const dispatchResult = await settle(
      set(
        dispatchAgentEventConsumers$,
        {
          runId: params.body.runId,
          events: params.body.events,
          context: {
            userId: params.auth.userId,
            orgId: run.orgId,
          },
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    if (!dispatchResult.ok) {
      if (isRequiredEventConsumerDispatchError(dispatchResult.error)) {
        return internalServerError(dispatchResult.error.message);
      }
      throw dispatchResult.error;
    }

    await publishRunChangedForUserSafely(
      params.auth.userId,
      params.body.runId,
      {
        firstSequence,
        lastSequence,
      },
    );
    signal.throwIfAborted();

    L.debug(
      `Events ${firstSequence}-${lastSequence} dispatched for run ${params.body.runId} (${now() - startedAt}ms)`,
    );

    return {
      status: 200 as const,
      body: {
        received: params.body.events.length,
        firstSequence,
        lastSequence,
      },
    };
  },
);
