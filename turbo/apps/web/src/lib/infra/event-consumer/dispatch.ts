import { eventConsumers } from "./registry";
import type { AgentEvent, RunEventContext } from "./types";
import { computeHmacSignature } from "../callback/hmac";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("event-consumer:dispatch");

interface DispatchableConsumer {
  name: string;
  path: string;
  required?: boolean;
  events: AgentEvent[];
}

function requiredEventConsumerDispatchError(failures: string[]): Error {
  const error = new Error(
    `Required event consumer dispatch failed: ${failures.join(", ")}`,
  );
  error.name = "RequiredEventConsumerDispatchError";
  return error;
}

/**
 * In local dev, rewrite self-referencing tunnel URLs to localhost.
 */
function resolveBaseUrl(baseUrl: string): string {
  const { NODE_ENV } = env();
  return NODE_ENV === "development" && baseUrl.startsWith("https://tunnel-")
    ? baseUrl.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : baseUrl;
}

async function dispatchToConsumer(
  consumer: DispatchableConsumer,
  runId: string,
  context: RunEventContext,
  baseUrl: string,
  secretsEncryptionKey: string,
): Promise<void> {
  const body = JSON.stringify({
    runId,
    events: consumer.events,
    context,
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeHmacSignature(body, secretsEncryptionKey, timestamp);

  const response = await fetch(baseUrl + consumer.path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VM0-Signature": signature,
      "X-VM0-Timestamp": timestamp.toString(),
    },
    body,
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => {
      return "";
    });
    throw new Error(
      `HTTP ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
    );
  }
  await response.arrayBuffer().catch(() => {
    return undefined;
  });
}

async function dispatchConsumerGroup(
  consumers: DispatchableConsumer[],
  runId: string,
  context: RunEventContext,
  baseUrl: string,
  secretsEncryptionKey: string,
): Promise<string[]> {
  const results = await Promise.allSettled(
    consumers.map((consumer) => {
      return dispatchToConsumer(
        consumer,
        runId,
        context,
        baseUrl,
        secretsEncryptionKey,
      );
    }),
  );

  const failures: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === "rejected") {
      const consumer = consumers[i];
      log.error(`Event consumer "${consumer?.name}" failed`, {
        runId,
        error: result.reason,
      });
      if (consumer?.required) {
        failures.push(consumer.name);
      }
    }
  }

  return failures;
}

/**
 * Dispatch agent events to all registered consumers whose eventTypes filter
 * matches at least one event in the batch.
 *
 * Required consumers run first. Optional consumers run only after required
 * consumers succeed, so a required failure cannot trigger webhook retry after
 * non-idempotent optional side effects have already been written.
 */
export async function dispatchToEventConsumers(
  runId: string,
  events: AgentEvent[],
  context: RunEventContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY, VM0_API_URL } = env();
  const baseUrl = resolveBaseUrl(VM0_API_URL ?? "http://localhost:3000");

  const consumers = eventConsumers
    .map((consumer): DispatchableConsumer | null => {
      const matchingEvents = consumer.eventTypes
        ? events.filter((e) => {
            return consumer.eventTypes!.includes(e.type);
          })
        : events;

      if (matchingEvents.length === 0) {
        return null;
      }

      return {
        name: consumer.name,
        path: consumer.path,
        required: consumer.required,
        events: matchingEvents,
      };
    })
    .filter((consumer): consumer is DispatchableConsumer => {
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
    runId,
    context,
    baseUrl,
    SECRETS_ENCRYPTION_KEY,
  );

  if (requiredFailures.length > 0) {
    throw requiredEventConsumerDispatchError(requiredFailures);
  }

  await dispatchConsumerGroup(
    optionalConsumers,
    runId,
    context,
    baseUrl,
    SECRETS_ENCRYPTION_KEY,
  );
}
