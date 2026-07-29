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
  partId: z.string().optional(),
});

export const zeroMailInlineImageSchema = z.object({
  contentId: z.string().min(1),
  partId: z.string().min(1),
  alt: z.string(),
});

export const zeroMailFollowUpSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("active"),
    automationId: z.string().uuid(),
  }),
  z.object({
    status: z.literal("paused"),
    automationId: z.string().uuid(),
  }),
]);

const zeroMailDraftBaseSchema = z.object({
  provider: z.literal("gmail"),
  from: z.email(),
  fromName: z.string().optional(),
  to: z.array(z.email()),
  cc: z.array(z.email()),
  bcc: z.array(z.email()),
  subject: z.string(),
  body: z.string(),
  bodyHtml: z.string().optional(),
  inlineImages: z.array(zeroMailInlineImageSchema).optional(),
  accessStatus: z.enum(["ready", "reconnect"]).optional(),
  replyTo: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  status: zeroMailDraftStatusSchema,
  detailAvailable: z.boolean(),
  gmailDraftId: z.string(),
  gmailThreadId: z.string(),
  gmailMessageId: z.string(),
  sentGmailMessageId: z.string().optional(),
  followUp: zeroMailFollowUpSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
});

export const zeroMailDraftSchema = zeroMailDraftBaseSchema.extend({
  version: z.literal(3),
  attachments: z.array(zeroMailAttachmentSchema),
});

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

const zeroMailDraftAttachmentPathParamsSchema =
  zeroMailDraftPathParamsSchema.extend({
    partId: z.string().min(1),
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
  getAttachment: {
    method: "GET",
    path: "/api/zero/mail/drafts/:mailDraftId/attachments/:partId",
    headers: authHeadersSchema,
    pathParams: zeroMailDraftAttachmentPathParamsSchema,
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: c.type<Blob>(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get a Gmail draft attachment",
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
  createFollowUp: {
    method: "POST",
    path: "/api/zero/mail/drafts/:mailDraftId/follow-up",
    headers: authHeadersSchema,
    pathParams: z.object({ mailDraftId: z.string().uuid() }),
    body: z.object({}),
    responses: {
      200: z.object({
        mailDraftId: z.string().uuid(),
        automationId: z.string().uuid(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Enable reply tracking for a sent Gmail message",
  },
});

export type ZeroMailProvider = z.infer<typeof zeroMailProviderSchema>;
export type ZeroMailDraftStatus = z.infer<typeof zeroMailDraftStatusSchema>;
export type ZeroMailAttachment = z.infer<typeof zeroMailAttachmentSchema>;
export type ZeroMailInlineImage = z.infer<typeof zeroMailInlineImageSchema>;
export type ZeroMailFollowUp = z.infer<typeof zeroMailFollowUpSchema>;
export type ZeroMailDraft = z.infer<typeof zeroMailDraftSchema>;
export type ZeroMailContract = typeof zeroMailContract;
