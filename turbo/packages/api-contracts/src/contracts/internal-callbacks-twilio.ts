import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const twilioCallbackPayloadSchema = z
  .object({
    messageSid: z.string(),
    rootMessageId: z.string(),
    phoneHandle: z.string(),
    fromNumber: z.string(),
    toNumber: z.string(),
    userLinkId: z.string(),
    agentId: z.string(),
    existingSessionId: z.string().nullable().optional(),
  })
  .passthrough();

export const internalCallbacksTwilioContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/twilio",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: twilioCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      502: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for Twilio WhatsApp-triggered runs",
  },
});

export type TwilioCallbackPayload = z.infer<typeof twilioCallbackPayloadSchema>;
export type InternalCallbacksTwilioContract =
  typeof internalCallbacksTwilioContract;
