import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const zeroMailProviderSchema = z.enum(["gmail", "outlook"]);

export const zeroMailDraftStatusSchema = z.enum(["draft", "sent", "deleted"]);

export const zeroMailAttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});

const zeroMailDraftBaseSchema = z.object({
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

export const zeroMailDraftV3Schema = zeroMailDraftBaseSchema.extend({
  version: z.literal(3),
  attachments: z.array(zeroMailAttachmentSchema),
});

export const zeroMailDraftSchema = zeroMailDraftV3Schema;

const zeroMailDraftResponseSchema = z.object({
  mailDraftId: z.string().uuid(),
  mailDraftUrl: z.url(),
  mailDraft: zeroMailDraftSchema,
});

const zeroMailLinkResponseSchema = zeroMailDraftResponseSchema.pick({
  mailDraftId: true,
  mailDraftUrl: true,
});

const zeroMailDraftPathParamsSchema = z.object({
  mailDraftId: z.string().uuid(),
});

export const zeroMailContract = c.router({
  linkDraft: {
    method: "POST",
    path: "/api/zero/mail/drafts/link",
    headers: authHeadersSchema,
    body: z.object({
      threadId: z.string().uuid(),
      agentId: z.string().uuid().optional(),
      gmailDraftId: z.string().min(1),
    }),
    responses: {
      200: zeroMailLinkResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link an existing Gmail draft to a web chat thread",
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
      409: apiErrorSchema,
    },
    summary: "Get an email draft by ID",
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
    body: c.noBody(),
    responses: {
      200: zeroMailDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Send a linked Gmail draft",
  },
});

export type ZeroMailProvider = z.infer<typeof zeroMailProviderSchema>;
export type ZeroMailDraftStatus = z.infer<typeof zeroMailDraftStatusSchema>;
export type ZeroMailAttachment = z.infer<typeof zeroMailAttachmentSchema>;
export type ZeroMailDraftV3 = z.infer<typeof zeroMailDraftV3Schema>;
export type ZeroMailDraft = z.infer<typeof zeroMailDraftSchema>;
export type ZeroMailContract = typeof zeroMailContract;
