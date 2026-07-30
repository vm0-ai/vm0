import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const directUploadCapabilityShape = {
  supportsUploadHeaders: z.literal(true).optional(),
};

const directUploadResponseShape = {
  uploadHeaders: z.record(z.string(), z.string()).optional(),
};

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
 * Integration Feishu message contract
 * POST /api/zero/integrations/feishu/message
 *
 * Sends a Feishu message via an org-owned custom app.
 * Requires `feishu:write` capability (via ZERO_TOKEN).
 */
const feishuCardSchema = z.record(z.string(), z.unknown());

const sendFeishuMessageBodySchema = z
  .object({
    installationId: z.string().uuid().optional(),
    chat: z.string().min(1, "Chat ID is required").optional(),
    user: z.string().min(1, "Feishu open ID is required").optional(),
    replyToMessageId: z.string().min(1, "Message ID is required").optional(),
    replyInThread: z.boolean().optional(),
    text: z.string().min(1, "Message text is required").optional(),
    card: feishuCardSchema.optional(),
  })
  .refine(
    (body) => {
      return (
        [body.chat, body.user, body.replyToMessageId].filter(Boolean).length ===
        1
      );
    },
    {
      message: "Exactly one of chat, user, or replyToMessageId is required",
      path: ["chat"],
    },
  )
  .refine(
    (body) => {
      return Boolean(body.text) !== Boolean(body.card);
    },
    {
      message: "Exactly one of text or card is required",
      path: ["text"],
    },
  )
  .refine(
    (body) => {
      return !body.replyInThread || Boolean(body.replyToMessageId);
    },
    {
      message: "replyInThread requires replyToMessageId",
      path: ["replyInThread"],
    },
  );

export type SendFeishuMessageBody = z.infer<typeof sendFeishuMessageBodySchema>;

const sendFeishuMessageResponseSchema = z.object({
  ok: z.literal(true),
  messageId: z.string(),
  chatId: z.string().nullable(),
});

export type SendFeishuMessageResponse = z.infer<
  typeof sendFeishuMessageResponseSchema
>;

export const integrationsFeishuMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/feishu/message",
    headers: authHeadersSchema,
    body: sendFeishuMessageBodySchema,
    responses: {
      200: sendFeishuMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a Feishu message via an organization custom app",
  },
});

export type IntegrationsFeishuMessageContract =
  typeof integrationsFeishuMessageContract;

export const FEISHU_FILE_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Integration Feishu message resource download contract.
 * Requires `feishu:write` because Feishu currently uses one capability for
 * bot-backed messaging and file access.
 */
const feishuResourceTypeSchema = z.enum(["file", "image"]);

export type FeishuResourceType = z.infer<typeof feishuResourceTypeSchema>;

export const integrationsFeishuDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/feishu/download-file",
    headers: authHeadersSchema,
    query: z.object({
      installation_id: z.string().uuid().optional(),
      message_id: z.string().min(1, "Message ID is required"),
      file_key: z.string().min(1, "File key is required"),
      type: feishuResourceTypeSchema,
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a file from a Feishu message",
  },
});

export type IntegrationsFeishuDownloadFileContract =
  typeof integrationsFeishuDownloadFileContract;

/**
 * Integration Feishu file upload — init contract.
 *
 * The CLI uploads to temporary VM0 storage before the API forwards the bytes
 * to Feishu with the organization bot's tenant token.
 */
const feishuUploadInitBodySchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(200),
  length: z
    .number()
    .int()
    .positive("File length must be a positive integer")
    .max(
      FEISHU_FILE_UPLOAD_MAX_BYTES,
      `File must not exceed ${FEISHU_FILE_UPLOAD_MAX_BYTES} bytes`,
    ),
  ...directUploadCapabilityShape,
});

export type FeishuUploadInitBody = z.infer<typeof feishuUploadInitBodySchema>;

const feishuUploadInitResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadUrl: z.string(),
  fileUrl: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type FeishuUploadInitResponse = z.infer<
  typeof feishuUploadInitResponseSchema
>;

export const integrationsFeishuUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/zero/integrations/feishu/upload-file/init",
    headers: authHeadersSchema,
    body: feishuUploadInitBodySchema,
    responses: {
      200: feishuUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for Feishu file delivery",
  },
});

/**
 * Integration Feishu file upload — complete contract.
 *
 * Uploads the stored bytes to Feishu and sends the resulting file key to one
 * chat, user, or reply target.
 */
const feishuUploadCompleteBodySchema = z
  .object({
    uploadId: z.string().uuid("Upload ID must be a UUID"),
    installationId: z.string().uuid().optional(),
    chat: z.string().min(1, "Chat ID is required").optional(),
    user: z.string().min(1, "Feishu open ID is required").optional(),
    replyToMessageId: z.string().min(1, "Message ID is required").optional(),
    replyInThread: z.boolean().optional(),
    contentType: z.string().min(1).max(200).optional(),
  })
  .refine(
    (body) => {
      return (
        [body.chat, body.user, body.replyToMessageId].filter(Boolean).length ===
        1
      );
    },
    {
      message: "Exactly one of chat, user, or replyToMessageId is required",
      path: ["chat"],
    },
  )
  .refine(
    (body) => {
      return !body.replyInThread || Boolean(body.replyToMessageId);
    },
    {
      message: "replyInThread requires replyToMessageId",
      path: ["replyInThread"],
    },
  );

export type FeishuUploadCompleteBody = z.infer<
  typeof feishuUploadCompleteBodySchema
>;

const feishuUploadCompleteResponseSchema = z.object({
  messageId: z.string(),
  chatId: z.string().nullable(),
  fileKey: z.string(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});

export type FeishuUploadCompleteResponse = z.infer<
  typeof feishuUploadCompleteResponseSchema
>;

export const integrationsFeishuUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/integrations/feishu/upload-file/complete",
    headers: authHeadersSchema,
    body: feishuUploadCompleteBodySchema,
    responses: {
      200: feishuUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Finalize Feishu file upload and send it to a conversation",
  },
});

/**
 * Integration Telegram message contract
 * POST /api/zero/integrations/telegram/message
 *
 * Sends a Telegram message via an org-owned bot token.
 * Requires `telegram:write` capability (via ZERO_TOKEN).
 */
const sendTelegramMessageBodySchema = z.object({
  botId: z.string().min(1, "Bot ID is required"),
  chatId: z.string().min(1, "Chat ID is required"),
  text: z.string().min(1, "Message text is required"),
  replyToMessageId: z.number().int().positive().optional(),
  messageThreadId: z.number().int().positive().optional(),
});

export type SendTelegramMessageBody = z.infer<
  typeof sendTelegramMessageBodySchema
>;

const sendTelegramMessageResponseSchema = z.object({
  ok: z.literal(true),
  messageId: z.number().int(),
  chatId: z.string(),
});

export type SendTelegramMessageResponse = z.infer<
  typeof sendTelegramMessageResponseSchema
>;

export const integrationsTelegramMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/telegram/message",
    headers: authHeadersSchema,
    body: sendTelegramMessageBodySchema,
    responses: {
      200: sendTelegramMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a Telegram message via org bot token",
  },
});

export type IntegrationsTelegramMessageContract =
  typeof integrationsTelegramMessageContract;

/**
 * Integration Microsoft Teams message contract
 * POST /api/zero/integrations/teams/message
 *
 * Sends a Microsoft Teams message via the org's installed Teams bot.
 * Requires `teams:write` capability (via ZERO_TOKEN).
 */
const teamsAdaptiveCardSchema = z
  .object({
    type: z.literal("AdaptiveCard"),
    version: z.string().min(1),
    body: z.array(z.record(z.string(), z.unknown())).optional(),
    actions: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const sendTeamsMessageBodySchema = z
  .object({
    conversationId: z.string().min(1, "Conversation ID is required").optional(),
    user: z.string().min(1, "Teams user ID is required").optional(),
    text: z.string().min(1, "Message text is required").optional(),
    activityId: z.string().min(1, "Activity ID is required").optional(),
    card: teamsAdaptiveCardSchema.optional(),
  })
  .refine(
    (body) => {
      return Boolean(body.conversationId) !== Boolean(body.user);
    },
    {
      message: "Exactly one of conversationId or user is required",
      path: ["conversationId"],
    },
  )
  .refine(
    (body) => {
      return Boolean(body.text) || Boolean(body.card);
    },
    {
      message: "Message text or card is required",
      path: ["text"],
    },
  )
  .refine(
    (body) => {
      return !(body.user && body.activityId);
    },
    {
      message: "activityId can only be used with conversationId",
      path: ["activityId"],
    },
  );

export type SendTeamsMessageBody = z.infer<typeof sendTeamsMessageBodySchema>;

const sendTeamsMessageResponseSchema = z.object({
  ok: z.literal(true),
  activityId: z.string().optional(),
  conversationId: z.string(),
});

export type SendTeamsMessageResponse = z.infer<
  typeof sendTeamsMessageResponseSchema
>;

export const integrationsTeamsMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/teams/message",
    headers: authHeadersSchema,
    body: sendTeamsMessageBodySchema,
    responses: {
      200: sendTeamsMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a Microsoft Teams message via org bot",
  },
});

export type IntegrationsTeamsMessageContract =
  typeof integrationsTeamsMessageContract;

/**
 * Integration AgentPhone message contract
 * POST /api/zero/integrations/phone/message
 *
 * Sends an AgentPhone text message to the connected phone handle.
 * Requires `phone:write` capability (via ZERO_TOKEN).
 */
const sendPhoneMessageBodySchema = z.object({
  agentphoneAgentId: z
    .string()
    .min(1, "AgentPhone agent ID is required")
    .optional(),
  toNumber: z.string().min(1, "Phone number is required"),
  text: z.string().min(1, "Message text is required"),
});

export type SendPhoneMessageBody = z.infer<typeof sendPhoneMessageBodySchema>;

const sendPhoneMessageResponseSchema = z.object({
  ok: z.literal(true),
  messageId: z.string(),
  channel: z.string().nullable(),
  toNumber: z.string(),
});

export type SendPhoneMessageResponse = z.infer<
  typeof sendPhoneMessageResponseSchema
>;

export const integrationsPhoneMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/phone/message",
    headers: authHeadersSchema,
    body: sendPhoneMessageBodySchema,
    responses: {
      200: sendPhoneMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send an AgentPhone message",
  },
});

export type IntegrationsPhoneMessageContract =
  typeof integrationsPhoneMessageContract;

const phoneDownloadFileQuerySchema = z.object({
  file_id: z.string().min(1, "file_id query parameter is required"),
});

export const integrationsPhoneDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/phone/download-file",
    headers: authHeadersSchema,
    query: phoneDownloadFileQuerySchema,
    responses: {
      200: c.type<Blob>(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download an AgentPhone media attachment",
  },
});

export type IntegrationsPhoneDownloadFileContract =
  typeof integrationsPhoneDownloadFileContract;

/**
 * Integration Telegram bot list contract
 * GET /api/zero/integrations/telegram/bots
 *
 * Lists Telegram bots available in the authenticated user's org.
 * Requires `telegram:read` capability (via ZERO_TOKEN).
 */
const telegramBotTokenStatusSchema = z.enum(["valid", "invalid", "unknown"]);

const telegramConnectedUserSchema = z.object({
  telegramUserId: z.string(),
  telegramUsername: z.string().nullable(),
  telegramDisplayName: z.string().nullable(),
});

const telegramBotListItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["custom", "official"]).optional(),
  username: z.string().nullable(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  isOwner: z.boolean(),
  isConnected: z.boolean(),
  connectedUser: telegramConnectedUserSchema.nullable().optional(),
  tokenStatus: telegramBotTokenStatusSchema,
  official: z
    .object({
      configured: z.boolean(),
      usesDefaultAgent: z.boolean(),
      linkedTelegramUserId: z.string().nullable(),
    })
    .optional(),
});

const listTelegramBotsResponseSchema = z.object({
  bots: z.array(telegramBotListItemSchema),
});

export type TelegramBotListItem = z.infer<typeof telegramBotListItemSchema>;
export type ListTelegramBotsResponse = z.infer<
  typeof listTelegramBotsResponseSchema
>;

export const integrationsTelegramBotListContract = c.router({
  listBots: {
    method: "GET",
    path: "/api/zero/integrations/telegram/bots",
    headers: authHeadersSchema,
    responses: {
      200: listTelegramBotsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List Telegram bots available in the authenticated user's org",
  },
});

export type IntegrationsTelegramBotListContract =
  typeof integrationsTelegramBotListContract;

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
  ...directUploadCapabilityShape,
  canonical: z
    .object({
      operationId: z.string().uuid(),
      contentType: z.string().min(1).max(200),
      checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
      channel: z.string().min(1, "Channel ID is required"),
      threadTs: z.string().optional(),
      title: z.string().optional(),
      initialComment: z.string().optional(),
    })
    .optional(),
});

export type SlackUploadInitBody = z.infer<typeof slackUploadInitBodySchema>;

const directSlackUploadInitResponseSchema = z.object({
  uploadUrl: z.string(),
  fileId: z.string(),
});

const canonicalSlackUploadInitResponseSchema = z.object({
  kind: z.literal("canonical"),
  assetId: z.string().uuid(),
  operationId: z.string().uuid(),
  uploadUrl: z.string().url().optional(),
  url: z.string().url(),
  ...directUploadResponseShape,
});

const slackUploadInitResponseSchema = z.union([
  directSlackUploadInitResponseSchema,
  canonicalSlackUploadInitResponseSchema,
]);

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

const slackUploadMaterializeBodySchema = z.object({
  assetId: z.string().uuid(),
  operationId: z.string().uuid(),
});

const slackUploadMaterializeResponseSchema = z.object({
  assetId: z.string().uuid(),
  url: z.string().url(),
  delivery: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("pending"),
      uploadUrl: z.string(),
      fileId: z.string(),
    }),
    z.object({
      status: z.literal("delivered"),
      fileId: z.string(),
      permalink: z.string(),
    }),
    z.object({
      status: z.literal("failed"),
      message: z.string(),
      retryable: z.boolean(),
    }),
  ]),
});

export type SlackUploadMaterializeBody = z.infer<
  typeof slackUploadMaterializeBodySchema
>;
export type SlackUploadMaterializeResponse = z.infer<
  typeof slackUploadMaterializeResponseSchema
>;

export const integrationsSlackUploadMaterializeContract = c.router({
  materialize: {
    method: "POST",
    path: "/api/zero/integrations/slack/upload-file/materialize",
    headers: authHeadersSchema,
    body: slackUploadMaterializeBodySchema,
    responses: {
      200: slackUploadMaterializeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Materialize a canonical Slack publication before delivery",
  },
});

/**
 * Integration Telegram file upload — init contract
 * POST /api/zero/integrations/telegram/upload-file/init
 *
 * Requests a pre-signed upload URL for a temporary VM0-hosted file. The CLI
 * uploads the file body directly to R2, then the complete route asks Telegram
 * to fetch that file URL with the org-owned bot token.
 * Requires `telegram:write` capability (via ZERO_TOKEN).
 */
const telegramUploadInitBodySchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(200),
  length: z.number().int().positive("File length must be a positive integer"),
  ...directUploadCapabilityShape,
});

export type TelegramUploadInitBody = z.infer<
  typeof telegramUploadInitBodySchema
>;

const telegramUploadInitResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadUrl: z.string(),
  fileUrl: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type TelegramUploadInitResponse = z.infer<
  typeof telegramUploadInitResponseSchema
>;

export const integrationsTelegramUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/zero/integrations/telegram/upload-file/init",
    headers: authHeadersSchema,
    body: telegramUploadInitBodySchema,
    responses: {
      200: telegramUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for Telegram file delivery",
  },
});

/**
 * Integration Microsoft Teams file upload — init contract
 * POST /api/zero/integrations/teams/upload-file/init
 *
 * Requests a pre-signed upload URL for a temporary VM0-hosted file. The CLI
 * uploads the file body directly to R2, then the complete route sends a Teams
 * message with the file attachment and public file URL.
 * Requires `teams:write` capability (via ZERO_TOKEN).
 */
const teamsUploadInitBodySchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(200),
  length: z.number().int().positive("File length must be a positive integer"),
  ...directUploadCapabilityShape,
});

export type TeamsUploadInitBody = z.infer<typeof teamsUploadInitBodySchema>;

const teamsUploadInitResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadUrl: z.string(),
  fileUrl: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type TeamsUploadInitResponse = z.infer<
  typeof teamsUploadInitResponseSchema
>;

export const integrationsTeamsUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/zero/integrations/teams/upload-file/init",
    headers: authHeadersSchema,
    body: teamsUploadInitBodySchema,
    responses: {
      200: teamsUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for Microsoft Teams file delivery",
  },
});

/**
 * Integration Telegram file upload — complete contract
 * POST /api/zero/integrations/telegram/upload-file/complete
 *
 * Sends an uploaded file URL to a Telegram chat via sendDocument using the
 * requested org-owned bot token.
 * Requires `telegram:write` capability (via ZERO_TOKEN).
 */
const telegramUploadCompleteBodySchema = z.object({
  uploadId: z.string().uuid("Upload ID must be a UUID"),
  botId: z.string().min(1, "Bot ID is required"),
  chatId: z.string().min(1, "Chat ID is required"),
  contentType: z.string().min(1).max(200).optional(),
  caption: z.string().max(1024).optional(),
  messageThreadId: z.number().int().positive().optional(),
});

export type TelegramUploadCompleteBody = z.infer<
  typeof telegramUploadCompleteBodySchema
>;

const telegramUploadCompleteResponseSchema = z.object({
  messageId: z.number().int(),
  chatId: z.string(),
  fileId: z.string().optional(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});

export type TelegramUploadCompleteResponse = z.infer<
  typeof telegramUploadCompleteResponseSchema
>;

export const integrationsTelegramUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/integrations/telegram/upload-file/complete",
    headers: authHeadersSchema,
    body: telegramUploadCompleteBodySchema,
    responses: {
      200: telegramUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Finalize Telegram file upload and send it to a chat",
  },
});

/**
 * Integration Microsoft Teams file upload — complete contract
 * POST /api/zero/integrations/teams/upload-file/complete
 *
 * Sends an uploaded file URL to a Microsoft Teams conversation using the org's
 * installed Teams bot.
 * Requires `teams:write` capability (via ZERO_TOKEN).
 */
const teamsUploadCompleteBodySchema = z.object({
  uploadId: z.string().uuid("Upload ID must be a UUID"),
  conversationId: z.string().min(1, "Conversation ID is required"),
  activityId: z.string().min(1, "Activity ID is required").optional(),
  contentType: z.string().min(1).max(200).optional(),
  text: z.string().max(4000).optional(),
});

export type TeamsUploadCompleteBody = z.infer<
  typeof teamsUploadCompleteBodySchema
>;

const teamsUploadCompleteResponseSchema = z.object({
  activityId: z.string().optional(),
  conversationId: z.string(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});

export type TeamsUploadCompleteResponse = z.infer<
  typeof teamsUploadCompleteResponseSchema
>;

export const integrationsTeamsUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/integrations/teams/upload-file/complete",
    headers: authHeadersSchema,
    body: teamsUploadCompleteBodySchema,
    responses: {
      200: teamsUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary:
      "Finalize Microsoft Teams file upload and send it to a conversation",
  },
});

/**
 * Integration GitHub file upload — init contract
 * POST /api/zero/integrations/github/upload-file/init
 *
 * Requests a pre-signed upload URL for a temporary VM0-hosted file. The CLI
 * uploads the file body directly to R2, then the complete route posts the file
 * URL back to a GitHub issue or pull request comment.
 * Requires `github:write` capability (via ZERO_TOKEN).
 */
const githubUploadInitBodySchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(200),
  length: z.number().int().positive("File length must be a positive integer"),
  ...directUploadCapabilityShape,
});

export type GithubUploadInitBody = z.infer<typeof githubUploadInitBodySchema>;

const githubUploadInitResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadUrl: z.string(),
  fileUrl: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type GithubUploadInitResponse = z.infer<
  typeof githubUploadInitResponseSchema
>;

export const integrationsGithubUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/zero/integrations/github/upload-file/init",
    headers: authHeadersSchema,
    body: githubUploadInitBodySchema,
    responses: {
      200: githubUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for GitHub file delivery",
  },
});

/**
 * Integration GitHub file upload — complete contract
 * POST /api/zero/integrations/github/upload-file/complete
 *
 * Posts an uploaded file URL to a GitHub issue or pull request comment using
 * the organization GitHub App installation token.
 * Requires `github:write` capability (via ZERO_TOKEN).
 */
const githubUploadCompleteBodySchema = z.object({
  uploadId: z.string().uuid("Upload ID must be a UUID"),
  repo: z
    .string()
    .min(1, "Repository is required")
    .regex(/^[^/\s]+\/[^/\s]+$/, "Repository must be owner/name"),
  issueNumber: z
    .number()
    .int()
    .positive("Issue or pull request number must be positive"),
  contentType: z.string().min(1).max(200).optional(),
  caption: z.string().max(65_536).optional(),
});

export type GithubUploadCompleteBody = z.infer<
  typeof githubUploadCompleteBodySchema
>;

const githubUploadCompleteResponseSchema = z.object({
  commentId: z.string(),
  repo: z.string(),
  issueNumber: z.number().int(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});

export type GithubUploadCompleteResponse = z.infer<
  typeof githubUploadCompleteResponseSchema
>;

export const integrationsGithubUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/integrations/github/upload-file/complete",
    headers: authHeadersSchema,
    body: githubUploadCompleteBodySchema,
    responses: {
      200: githubUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Finalize GitHub file upload and post it to an issue or PR",
  },
});

/**
 * Integration AgentPhone file upload — init contract
 * POST /api/zero/integrations/phone/upload-file/init
 *
 * Requests a pre-signed upload URL for a VM0-hosted file. The CLI uploads the
 * file body directly to R2, then complete sends the public file URL through
 * AgentPhone.
 * Requires `phone:write` capability (via ZERO_TOKEN).
 */
const phoneUploadInitBodySchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required").max(200),
  length: z.number().int().positive("File length must be a positive integer"),
  ...directUploadCapabilityShape,
});

export type PhoneUploadInitBody = z.infer<typeof phoneUploadInitBodySchema>;

const phoneUploadInitResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadUrl: z.string(),
  fileUrl: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type PhoneUploadInitResponse = z.infer<
  typeof phoneUploadInitResponseSchema
>;

export const integrationsPhoneUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/zero/integrations/phone/upload-file/init",
    headers: authHeadersSchema,
    body: phoneUploadInitBodySchema,
    responses: {
      200: phoneUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for AgentPhone file delivery",
  },
});

/**
 * Integration AgentPhone file upload — complete contract
 * POST /api/zero/integrations/phone/upload-file/complete
 *
 * Sends an uploaded file URL to a connected phone handle through AgentPhone.
 * Requires `phone:write` capability (via ZERO_TOKEN).
 */
const phoneUploadCompleteBodySchema = z.object({
  uploadId: z.string().uuid("Upload ID must be a UUID"),
  agentphoneAgentId: z
    .string()
    .min(1, "AgentPhone agent ID is required")
    .optional(),
  toNumber: z.string().min(1, "Phone number is required"),
  contentType: z.string().min(1).max(200).optional(),
  caption: z.string().max(1024).optional(),
});

export type PhoneUploadCompleteBody = z.infer<
  typeof phoneUploadCompleteBodySchema
>;

const phoneUploadCompleteResponseSchema = z.object({
  messageId: z.string(),
  channel: z.string().nullable(),
  toNumber: z.string(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});

export type PhoneUploadCompleteResponse = z.infer<
  typeof phoneUploadCompleteResponseSchema
>;

export const integrationsPhoneUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/integrations/phone/upload-file/complete",
    headers: authHeadersSchema,
    body: phoneUploadCompleteBodySchema,
    responses: {
      200: phoneUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Finalize AgentPhone file upload and send it to a phone handle",
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
  canonicalAssetId: z.string().uuid().optional(),
  operationId: z.string().uuid().optional(),
  uploadError: z.string().max(2000).optional(),
});

export type SlackUploadCompleteBody = z.infer<
  typeof slackUploadCompleteBodySchema
>;

const slackUploadCompleteResponseSchema = z.object({
  fileId: z.string(),
  permalink: z.string(),
  assetId: z.string().uuid().optional(),
  assetUrl: z.string().url().optional(),
  deliveryStatus: z.enum(["delivered", "failed"]).optional(),
  deliveryError: z.string().optional(),
});

export type SlackUploadCompleteResponse = z.infer<
  typeof slackUploadCompleteResponseSchema
>;

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
