import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Integration Slack message contract
 * POST /api/zero/integrations/slack/message
 *
 * Sends a Slack message via the org's installed bot token.
 * Requires `slack:write` capability (via ZERO_TOKEN).
 */
const sendSlackMessageBodySchema = z
  .object({
    channel: z.string().min(1, "Channel ID is required").optional(),
    user: z.string().min(1, "User ID is required").optional(),
    text: z.string().optional(),
    threadTs: z.string().optional(),
    blocks: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  })
  .refine(
    (data) => {
      return Boolean(data.channel) !== Boolean(data.user);
    },
    { message: "Exactly one of 'channel' or 'user' must be provided" },
  );

export type SendSlackMessageBody = z.infer<typeof sendSlackMessageBodySchema>;

const sendSlackMessageResponseSchema = z.object({
  ok: z.literal(true),
  ts: z.string().optional(),
  channel: z.string().optional(),
});

export type SendSlackMessageResponse = z.infer<
  typeof sendSlackMessageResponseSchema
>;

export const integrationsSlackMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/slack/message",
    headers: authHeadersSchema,
    body: sendSlackMessageBodySchema,
    responses: {
      200: sendSlackMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Send a Slack message via org bot token",
  },
});

export type IntegrationsSlackMessageContract =
  typeof integrationsSlackMessageContract;

/**
 * Integration Slack file upload — init contract
 * POST /api/zero/integrations/slack/upload-file/init
 *
 * Requests a pre-signed upload URL from Slack via the org's bot token.
 * The CLI then uploads the file directly to that URL (no auth needed).
 * Requires `slack:write` capability (via ZERO_TOKEN).
 */
const slackUploadInitBodySchema = z.object({
  filename: z.string().min(1, "Filename is required"),
  length: z.number().int().positive("File length must be a positive integer"),
});

export type SlackUploadInitBody = z.infer<typeof slackUploadInitBodySchema>;

const slackUploadInitResponseSchema = z.object({
  uploadUrl: z.string(),
  fileId: z.string(),
});

export type SlackUploadInitResponse = z.infer<
  typeof slackUploadInitResponseSchema
>;

export const integrationsSlackUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/zero/integrations/slack/upload-file/init",
    headers: authHeadersSchema,
    body: slackUploadInitBodySchema,
    responses: {
      200: slackUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a pre-signed Slack upload URL via org bot token",
  },
});

/**
 * Integration Slack file upload — complete contract
 * POST /api/zero/integrations/slack/upload-file/complete
 *
 * Finalizes a Slack file upload and shares it to a channel/thread.
 * Requires `slack:write` capability (via ZERO_TOKEN).
 */
const slackUploadCompleteBodySchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  channel: z.string().min(1, "Channel ID is required"),
  threadTs: z.string().optional(),
  title: z.string().optional(),
  initialComment: z.string().optional(),
});

export type SlackUploadCompleteBody = z.infer<
  typeof slackUploadCompleteBodySchema
>;

const slackUploadCompleteResponseSchema = z.object({
  fileId: z.string(),
  permalink: z.string(),
});

export type SlackUploadCompleteResponse = z.infer<
  typeof slackUploadCompleteResponseSchema
>;

/**
 * Integration Chat message contract
 * POST /api/zero/integrations/chat/message
 *
 * Sends a message to a web chat thread.
 * Requires `chat-message:write` capability (via ZERO_TOKEN).
 */
const sendChatMessageBodySchema = z
  .object({
    thread: z.string().uuid("Invalid thread ID").optional(),
    agent: z.string().uuid("Invalid agent ID").optional(),
    text: z.string().min(1, "Message text is required"),
    title: z.string().min(1, "Title must not be empty").optional(),
  })
  .refine(
    (data) => {
      return Boolean(data.thread) !== Boolean(data.agent);
    },
    { message: "Exactly one of 'thread' or 'agent' must be provided" },
  );

export type SendChatMessageBody = z.infer<typeof sendChatMessageBodySchema>;

const sendChatMessageResponseSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  createdAt: z.string(),
});

export type SendChatMessageResponse = z.infer<
  typeof sendChatMessageResponseSchema
>;

export const integrationsChatMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/chat/message",
    headers: authHeadersSchema,
    body: sendChatMessageBodySchema,
    responses: {
      201: sendChatMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Send a message to a web chat thread",
  },
});

export type IntegrationsChatMessageContract =
  typeof integrationsChatMessageContract;

export const integrationsSlackUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/integrations/slack/upload-file/complete",
    headers: authHeadersSchema,
    body: slackUploadCompleteBodySchema,
    responses: {
      200: slackUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Finalize Slack file upload and share to channel",
  },
});
