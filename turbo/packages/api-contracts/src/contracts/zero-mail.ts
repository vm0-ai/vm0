import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroMailProviderSchema = z.enum(["gmail", "outlook"]);

export const zeroMailDraftStatusSchema = z.enum([
  "draft",
  "sending",
  "sent",
  "cancelled",
  "failed",
  "delivery_unknown",
]);

const mailSubjectSchema = z
  .string()
  .min(1)
  .refine((value) => {
    return !value.includes("\r") && !value.includes("\n");
  }, "Subject must not contain line breaks");

export const zeroMailDraftSchema = z.object({
  version: z.literal(1),
  provider: zeroMailProviderSchema,
  from: z.email(),
  to: z.array(z.email()).min(1),
  subject: mailSubjectSchema,
  body: z.string().min(1),
  status: zeroMailDraftStatusSchema,
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
});

const zeroMailDraftFieldsSchema = z.object({
  to: z.array(z.email()).min(1),
  subject: mailSubjectSchema,
  body: z.string().min(1),
});

const zeroMailDraftResponseSchema = z.object({
  messageId: z.string().uuid(),
  mailDraft: zeroMailDraftSchema,
});

const zeroMailDraftPathParamsSchema = z.object({
  threadId: z.string().uuid(),
  messageId: z.string().uuid(),
});

export const zeroMailContract = c.router({
  createDraft: {
    method: "POST",
    path: "/api/zero/mail/drafts",
    headers: authHeadersSchema,
    body: zeroMailDraftFieldsSchema.extend({
      threadId: z.string().uuid(),
      agentId: z.string().uuid(),
      provider: zeroMailProviderSchema.optional(),
    }),
    responses: {
      201: zeroMailDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a persistent email draft card in a web chat thread",
  },
  updateDraft: {
    method: "PATCH",
    path: "/api/zero/mail/drafts/:threadId/:messageId",
    headers: authHeadersSchema,
    pathParams: zeroMailDraftPathParamsSchema,
    body: zeroMailDraftFieldsSchema,
    responses: {
      200: zeroMailDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Persist edits to an email draft card",
  },
  cancelDraft: {
    method: "POST",
    path: "/api/zero/mail/drafts/:threadId/:messageId/cancel",
    headers: authHeadersSchema,
    pathParams: zeroMailDraftPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: zeroMailDraftResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Cancel an email draft card",
  },
  sendDraft: {
    method: "POST",
    path: "/api/zero/mail/drafts/:threadId/:messageId/send",
    headers: authHeadersSchema,
    pathParams: zeroMailDraftPathParamsSchema,
    body: zeroMailDraftFieldsSchema,
    responses: {
      200: zeroMailDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Persist the latest edits and send an email draft exactly once",
  },
});

export type ZeroMailProvider = z.infer<typeof zeroMailProviderSchema>;
export type ZeroMailDraftStatus = z.infer<typeof zeroMailDraftStatusSchema>;
export type ZeroMailDraft = z.infer<typeof zeroMailDraftSchema>;
export type ZeroMailContract = typeof zeroMailContract;
