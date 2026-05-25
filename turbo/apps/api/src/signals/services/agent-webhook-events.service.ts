import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";

import type {
  AgentEvent,
  RunEventContext,
} from "../../lib/event-consumer/verify";
import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { db$ } from "../external/db";
import { publishRunChangedForUserSafely } from "../external/realtime";
import { bestEffort, settle } from "../utils";

const L = logger("webhook:events");

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
  readonly path: string;
  readonly required?: boolean;
  readonly eventTypes?: readonly string[];
}

interface PreparedConsumer {
  readonly name: string;
  readonly path: string;
  readonly required?: boolean;
  readonly events: readonly AgentEvent[];
}

interface DispatchAgentEventConsumersParams {
  readonly runId: string;
  readonly events: readonly AgentEvent[];
  readonly context: RunEventContext;
}

interface DispatchRuntime {
  readonly runId: string;
  readonly context: RunEventContext;
  readonly baseUrl: string;
  readonly secretsEncryptionKey: string;
  readonly signal: AbortSignal;
}

const EVENT_CONSUMERS: readonly DispatchableConsumer[] = [
  {
    name: "axiom",
    path: "/api/internal/event-consumers/axiom",
    required: true,
  },
  {
    name: "chat-assistant",
    path: "/api/internal/event-consumers/chat-assistant",
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

function resolveBaseUrl(baseUrl: string): string {
  return env("ENV") === "development" && baseUrl.startsWith("https://tunnel-")
    ? baseUrl.replace(/^https:\/\/tunnel-[^/]+/u, "http://localhost:3000")
    : baseUrl;
}

async function readFailureBody(response: Response): Promise<string> {
  const settled = await settle(response.text());
  return settled.ok ? settled.value : "";
}

async function drainResponse(response: Response): Promise<void> {
  await bestEffort(response.arrayBuffer());
}

async function dispatchToConsumer(
  consumer: PreparedConsumer,
  runtime: DispatchRuntime,
): Promise<void> {
  const body = JSON.stringify({
    runId: runtime.runId,
    events: consumer.events,
    context: runtime.context,
  });
  const timestamp = Math.floor(now() / 1000);
  const signature = computeHmacSignature(
    body,
    runtime.secretsEncryptionKey,
    timestamp,
  );

  const response = await fetch(`${runtime.baseUrl}${consumer.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VM0-Signature": signature,
      "X-VM0-Timestamp": timestamp.toString(),
    },
    body,
    signal: runtime.signal,
  });
  runtime.signal.throwIfAborted();

  if (!response.ok) {
    const responseBody = await readFailureBody(response);
    runtime.signal.throwIfAborted();
    throw new Error(
      `HTTP ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
    );
  }

  await drainResponse(response);
  runtime.signal.throwIfAborted();
}

async function dispatchConsumerGroup(
  consumers: readonly PreparedConsumer[],
  runtime: DispatchRuntime,
): Promise<readonly string[]> {
  const results = await Promise.allSettled(
    consumers.map((consumer) => {
      return dispatchToConsumer(consumer, runtime);
    }),
  );
  runtime.signal.throwIfAborted();

  const failures: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const consumer = consumers[index];
      L.error(`Event consumer "${consumer?.name}" failed`, {
        runId: runtime.runId,
        error: result.reason,
      });
      if (consumer?.required) {
        failures.push(consumer.name);
      }
    }
  }

  return failures;
}

const dispatchAgentEventConsumers$ = command(
  async (
    _store,
    params: DispatchAgentEventConsumersParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const runtime: DispatchRuntime = {
      runId: params.runId,
      context: params.context,
      baseUrl: resolveBaseUrl(env("VM0_API_URL")),
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
      signal,
    };

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
          path: consumer.path,
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

    const requiredFailures = await dispatchConsumerGroup(
      requiredConsumers,
      runtime,
    );
    signal.throwIfAborted();

    if (requiredFailures.length > 0) {
      throw new RequiredEventConsumerDispatchError(requiredFailures);
    }

    await dispatchConsumerGroup(optionalConsumers, runtime);
    signal.throwIfAborted();
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
