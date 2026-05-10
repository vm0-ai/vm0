import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

/**
 * Headers required for HMAC-signed internal event-consumer requests.
 *
 * Mirrors the dispatch headers that `apps/web/src/lib/infra/event-consumer/dispatch.ts`
 * produces. The signature scheme matches `apps/api/src/lib/event-consumer/hmac.ts`.
 */
export const eventConsumerHeadersSchema = z.object({
  "x-vm0-signature": z.string().optional(),
  "x-vm0-timestamp": z.string().optional(),
});

/**
 * Refresh Telegram typing indicators for all pending Telegram callbacks
 * attached to a run. Triggered by the events webhook on every batch.
 *
 * The body schema only requires `runId`; everything else is forwarded
 * verbatim to the background refresh task without validation, matching
 * web's permissive behaviour.
 */
export const internalEventConsumerTelegramTypingContract = c.router({
  refresh: {
    method: "POST",
    path: "/api/internal/event-consumers/telegram-typing",
    headers: eventConsumerHeadersSchema,
    body: z.object({ runId: z.string() }).passthrough(),
    responses: {
      200: z.object({ scheduled: z.literal(true) }),
      401: z.object({ error: z.string() }),
    },
    summary:
      "Refresh Telegram typing indicators for all pending callbacks of a run",
  },
});

export type InternalEventConsumerTelegramTypingContract =
  typeof internalEventConsumerTelegramTypingContract;
