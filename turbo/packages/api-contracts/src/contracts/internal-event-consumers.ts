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

export const eventConsumerEventSchema = z
  .object({
    type: z.string(),
    sequenceNumber: z.number(),
  })
  .passthrough();

export const eventConsumerPayloadSchema = z
  .object({
    runId: z.string(),
    events: z.array(eventConsumerEventSchema),
    context: z
      .object({
        userId: z.string(),
        orgId: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const eventConsumerUnauthorizedSchema = z.object({
  error: z.string(),
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
      401: eventConsumerUnauthorizedSchema,
    },
    summary:
      "Refresh Telegram typing indicators for all pending callbacks of a run",
  },
});

export const internalEventConsumerAxiomContract = c.router({
  ingest: {
    method: "POST",
    path: "/api/internal/event-consumers/axiom",
    headers: eventConsumerHeadersSchema,
    body: eventConsumerPayloadSchema,
    responses: {
      200: z.object({ received: z.number() }),
      401: eventConsumerUnauthorizedSchema,
      503: z.object({ error: z.string() }),
    },
    summary: "Ingest agent run events into Axiom",
  },
});

export const internalEventConsumerChatAssistantContract = c.router({
  process: {
    method: "POST",
    path: "/api/internal/event-consumers/chat-assistant",
    headers: eventConsumerHeadersSchema,
    body: eventConsumerPayloadSchema,
    responses: {
      200: z.object({ processed: z.number() }),
      401: eventConsumerUnauthorizedSchema,
    },
    summary: "Persist assistant-visible run events into chat threads",
  },
});

export const internalEventConsumerVoiceChatContract = c.router({
  process: {
    method: "POST",
    path: "/api/internal/event-consumers/voice-chat",
    headers: eventConsumerHeadersSchema,
    body: eventConsumerPayloadSchema,
    responses: {
      200: z.object({ processed: z.number() }),
      401: eventConsumerUnauthorizedSchema,
    },
    summary: "Append assistant run events into voice-chat tasks",
  },
});

export type InternalEventConsumerAxiomContract =
  typeof internalEventConsumerAxiomContract;

export type InternalEventConsumerChatAssistantContract =
  typeof internalEventConsumerChatAssistantContract;

export type InternalEventConsumerTelegramTypingContract =
  typeof internalEventConsumerTelegramTypingContract;

export type InternalEventConsumerVoiceChatContract =
  typeof internalEventConsumerVoiceChatContract;
