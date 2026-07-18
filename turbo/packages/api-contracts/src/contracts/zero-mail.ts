import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroMailProviderSchema = z.enum(["gmail", "outlook"]);

export const zeroMailDraftStatusSchema = z.enum(["draft", "sent", "deleted"]);

const mailSubjectSchema = z
  .string()
  .min(1)
  .refine((value) => {
    return !value.includes("\r") && !value.includes("\n");
  }, "Subject must not contain line breaks");

const mailHeaderValueSchema = z.string().refine((value) => {
  return !value.includes("\r") && !value.includes("\n");
}, "Mail header values must not contain line breaks");

const zeroMailDraftFieldsSchema = z.object({
  to: z.array(z.email()).min(1),
  cc: z.array(z.email()).optional(),
  bcc: z.array(z.email()).optional(),
  subject: mailSubjectSchema,
  body: z.string().min(1),
});

export const zeroMailDraftSchema = z.object({
  version: z.literal(2),
  provider: z.literal("gmail"),
  from: z.email(),
  fromName: z.string().optional(),
  to: z.array(z.email()),
  cc: z.array(z.email()),
  bcc: z.array(z.email()),
  subject: z.string(),
  body: z.string(),
  replyTo: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  status: zeroMailDraftStatusSchema,
  detailAvailable: z.boolean(),
  gmailDraftId: z.string(),
  gmailThreadId: z.string(),
  gmailMessageId: z.string(),
  sentGmailMessageId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
});

const zeroMailDraftResponseSchema = z.object({
  mailDraftId: z.string().uuid(),
  mailDraftUrl: z.url(),
  mailDraft: zeroMailDraftSchema,
});

const zeroMailDraftPathParamsSchema = z.object({
  mailDraftId: z.string().uuid(),
});

export const zeroMailContract = c.router({
  createDraft: {
    method: "POST",
    path: "/api/zero/mail/drafts",
    headers: authHeadersSchema,
    body: zeroMailDraftFieldsSchema.extend({
      threadId: z.string().uuid(),
      agentId: z.string().uuid().optional(),
      provider: zeroMailProviderSchema.optional(),
      replyTo: mailHeaderValueSchema.optional(),
      inReplyTo: mailHeaderValueSchema.optional(),
      references: z.array(mailHeaderValueSchema).optional(),
      gmailThreadId: mailHeaderValueSchema.optional(),
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
  getDraft: {
    method: "GET",
    path: "/api/zero/mail/drafts/:mailDraftId",
    headers: authHeadersSchema,
    pathParams: zeroMailDraftPathParamsSchema,
    responses: {
      200: zeroMailDraftResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get an email draft by ID",
  },
  updateDraft: {
    method: "PATCH",
    path: "/api/zero/mail/drafts/:mailDraftId",
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
  deleteDraft: {
    method: "DELETE",
    path: "/api/zero/mail/drafts/:mailDraftId",
    headers: authHeadersSchema,
    pathParams: zeroMailDraftPathParamsSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Permanently delete a Gmail draft and its vm0 record",
  },
  sendDraft: {
    method: "POST",
    path: "/api/zero/mail/drafts/:mailDraftId/send",
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
    summary: "Save the latest edits and send a Gmail draft",
  },
});

export type ZeroMailProvider = z.infer<typeof zeroMailProviderSchema>;
export type ZeroMailDraftStatus = z.infer<typeof zeroMailDraftStatusSchema>;
export type ZeroMailDraft = z.infer<typeof zeroMailDraftSchema>;
export type ZeroMailContract = typeof zeroMailContract;
