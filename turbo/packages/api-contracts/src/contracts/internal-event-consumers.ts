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

export const eventConsumerUnauthorizedSchema = z.object({
  error: z.string(),
});

export const internalEventConsumerAgentPhoneTypingContract = c.router({
  refresh: {
    method: "POST",
    path: "/api/internal/event-consumers/agentphone-typing",
    headers: eventConsumerHeadersSchema,
    body: z.object({ runId: z.string() }).passthrough(),
    responses: {
      200: z.object({ scheduled: z.literal(true) }),
      401: eventConsumerUnauthorizedSchema,
    },
    summary:
      "Refresh AgentPhone typing indicators for all pending iMessage callbacks of a run",
  },
});

export type InternalEventConsumerAgentPhoneTypingContract =
  typeof internalEventConsumerAgentPhoneTypingContract;
