import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const agentPhoneCallbackPayloadSchema = z
  .object({
    messageId: z.string(),
    conversationId: z.string().nullable(),
    channel: z.string().optional(),
    isGroup: z.boolean().optional(),
    rootMessageId: z.string().optional(),
    phoneHandle: z.string(),
    fromNumber: z.string(),
    toNumber: z.string(),
    userLinkId: z.string(),
    agentId: z.string(),
    agentphoneAgentId: z.string(),
    existingSessionId: z.string().nullable().optional(),
  })
  .passthrough();

export const internalCallbacksAgentPhoneContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/agentphone",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: agentPhoneCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      502: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for AgentPhone-triggered runs",
  },
});

export type AgentPhoneCallbackPayload = z.infer<
  typeof agentPhoneCallbackPayloadSchema
>;
export type InternalCallbacksAgentPhoneContract =
  typeof internalCallbacksAgentPhoneContract;
