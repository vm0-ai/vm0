import { eventConsumers } from "./registry";
import type { AgentEvent, RunEventContext } from "./types";
import { computeHmacSignature } from "../callback/hmac";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("event-consumer:dispatch");

/**
 * In local dev, rewrite self-referencing tunnel URLs to localhost.
 */
function resolveBaseUrl(baseUrl: string): string {
  const { NODE_ENV } = env();
  return NODE_ENV === "development" && baseUrl.startsWith("https://tunnel-")
    ? baseUrl.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : baseUrl;
}

/**
 * Dispatch agent events to all registered consumers whose eventTypes filter
 * matches at least one event in the batch.
 *
 * Uses `Promise.allSettled` — one consumer's failure does not affect others.
 * Failures are logged but not propagated to the caller.
 */
export async function dispatchToEventConsumers(
  runId: string,
  events: AgentEvent[],
  context: RunEventContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY, VM0_API_URL } = env();
  const baseUrl = resolveBaseUrl(VM0_API_URL ?? "http://localhost:3000");

  const results = await Promise.allSettled(
    eventConsumers.map((consumer) => {
      const matchingEvents = consumer.eventTypes
        ? events.filter((e) => {
            return consumer.eventTypes!.includes(e.type);
          })
        : events;

      if (matchingEvents.length === 0) {
        return Promise.resolve();
      }

      const body = JSON.stringify({
        runId,
        events: matchingEvents,
        context,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const signature = computeHmacSignature(
        body,
        SECRETS_ENCRYPTION_KEY,
        timestamp,
      );

      return fetch(baseUrl + consumer.path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": signature,
          "X-VM0-Timestamp": timestamp.toString(),
        },
        body,
      });
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === "rejected") {
      log.error(`Event consumer "${eventConsumers[i]?.name}" failed`, {
        runId,
        error: result.reason,
      });
    }
  }
}
