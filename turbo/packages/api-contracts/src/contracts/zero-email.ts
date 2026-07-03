import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessWithSkippedSchema,
} from "./internal-callbacks-shared";

const c = initContract();

const emailRecipientsSchema = z.array(z.string()).optional();

export const zeroEmailReplyCallbackPayloadSchema = z
  .object({
    emailThreadSessionId: z.string(),
    inboundEmailId: z.string(),
    inboundMessageId: z.string().optional(),
    inboundReferences: z.string().optional(),
    replyRecipientTo: emailRecipientsSchema,
    replyRecipientCc: emailRecipientsSchema,
  })
  .passthrough();

export const zeroEmailTriggerCallbackPayloadSchema = z
  .object({
    senderEmail: z.string(),
    agentId: z.string(),
    userId: z.string(),
    inboundEmailId: z.string(),
    replyToken: z.string(),
    inboundMessageId: z.string().optional(),
    inboundReferences: z.string().optional(),
    subject: z.string().optional(),
    runtimeOrgId: z.string().optional(),
    replyRecipientTo: emailRecipientsSchema,
    replyRecipientCc: emailRecipientsSchema,
  })
  .passthrough();

export const zeroEmailReplyCallbackContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/email/callbacks/reply",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: zeroEmailReplyCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessWithSkippedSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle Zero email reply completion callbacks",
  },
});

export const zeroEmailTriggerCallbackContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/email/callbacks/trigger",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: zeroEmailTriggerCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessWithSkippedSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle Zero email trigger completion callbacks",
  },
});

export const zeroEmailInboundContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/email/inbound",
    headers: z.object({
      "svix-id": z.string().optional(),
      "svix-timestamp": z.string().optional(),
      "svix-signature": z.string().optional(),
    }),
    body: z.unknown(),
    responses: {
      200: z.object({ received: z.literal(true) }),
      401: z.object({ error: z.string() }),
    },
    summary: "Handle Resend inbound email webhooks",
  },
});

export type ZeroEmailReplyCallbackPayload = z.infer<
  typeof zeroEmailReplyCallbackPayloadSchema
>;
export type ZeroEmailTriggerCallbackPayload = z.infer<
  typeof zeroEmailTriggerCallbackPayloadSchema
>;
