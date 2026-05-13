import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const OFFICIAL_TELEGRAM_BOT_ID = "official" as const;

const telegramEnvironmentSchema = z.object({
  requiredSecrets: z.array(z.string()),
  requiredVars: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  missingVars: z.array(z.string()),
});

const telegramTokenStatusSchema = z.enum(["valid", "invalid", "unknown"]);

const telegramConnectedUserSchema = z.object({
  telegramUserId: z.string(),
  telegramUsername: z.string().nullable(),
  telegramDisplayName: z.string().nullable(),
});

const telegramBotSchema = z.object({
  id: z.string(),
  kind: z.enum(["custom", "official"]).optional(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  isOwner: z.boolean(),
  isConnected: z.boolean(),
  connectedUser: telegramConnectedUserSchema.nullable().optional(),
  tokenStatus: telegramTokenStatusSchema,
  official: z
    .object({
      configured: z.boolean(),
      usesDefaultAgent: z.boolean(),
      linkedTelegramUserId: z.string().nullable(),
    })
    .optional(),
});

const telegramBotStatusSchema = telegramBotSchema.extend({
  domainConfigured: z.boolean(),
  environment: telegramEnvironmentSchema,
});

const telegramListResponseSchema = z.object({
  bots: z.array(telegramBotSchema),
});

const telegramUpdateBodySchema = z.object({
  defaultAgentId: z.string().trim().min(1).optional(),
  selectedAgentId: z.string().trim().min(1).nullable().optional(),
});

const telegramLinkStatusResponseSchema = z.discriminatedUnion("linked", [
  z.object({
    linked: z.literal(true),
    telegramUserId: z.string(),
    botUsername: z.string().optional(),
  }),
  z.object({
    linked: z.literal(false),
    installation: z
      .object({
        id: z.string(),
        botUsername: z.string(),
        loginBotId: z.string().optional(),
        domainConfigured: z.boolean().optional(),
      })
      .optional(),
  }),
]);

const telegramConnectSignatureSchema = z.object({
  telegramUserId: z.string().min(1),
  telegramUsername: z.string().max(255).optional(),
  telegramDisplayName: z.string().max(255).optional(),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const telegramAuthSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
});

const telegramLinkBodySchema = z.object({
  telegramBotId: z.string().min(1),
  telegramAuth: telegramAuthSchema.optional(),
  connectSignature: telegramConnectSignatureSchema.optional(),
});

const telegramLinkResponseSchema = z.object({
  botUsername: z.string(),
  telegramUserId: z.string(),
});

const telegramRegisterBodySchema = z.object({
  botToken: z.string().min(1),
  defaultAgentId: z.string().trim().min(1).optional(),
  reinstallBotId: z.string().min(1).optional(),
});

const telegramSetupStatusBodySchema = z.object({
  botToken: z.string().min(1),
  origin: z.string().optional(),
});

const telegramSetupStatusSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  domainConfigured: z.boolean(),
  privacyDisabled: z.boolean(),
});

/**
 * Zero integrations Telegram contract
 * Covers all Telegram integration endpoints.
 *
 * Path note: these endpoints use /api/integrations/ and /api/telegram/ (not /api/zero/)
 * because they are served by the platform app directly, not the Zero sub-application.
 * This is intentional and matches the real server routing.
 */
export const zeroIntegrationsTelegramContract = c.router({
  list: {
    method: "GET",
    path: "/api/integrations/telegram",
    headers: authHeadersSchema,
    responses: {
      200: telegramListResponseSchema,
      401: apiErrorSchema,
    },
    summary: "List Telegram bot integrations in the authenticated user's org",
  },
  getBot: {
    method: "GET",
    path: "/api/integrations/telegram/:botId",
    headers: authHeadersSchema,
    pathParams: z.object({ botId: z.string().min(1) }),
    responses: {
      200: telegramBotStatusSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get Telegram bot integration status",
  },
  updateBot: {
    method: "PATCH",
    path: "/api/integrations/telegram/:botId",
    headers: authHeadersSchema,
    pathParams: z.object({ botId: z.string().min(1) }),
    body: telegramUpdateBodySchema,
    responses: {
      200: telegramBotStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update the default agent for the Telegram bot",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/telegram/:botId",
    headers: authHeadersSchema,
    pathParams: z.object({ botId: z.string().min(1) }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall the Telegram bot",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    query: z.object({ botId: z.string().optional() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the authenticated user's Telegram account link",
  },
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    query: z.object({
      botId: z.string().optional(),
      origin: z.string().optional(),
    }),
    responses: {
      200: telegramLinkStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Check if the authenticated user is linked to a Telegram bot",
  },
  avatar: {
    method: "GET",
    path: "/api/integrations/telegram/:botId/avatar",
    headers: authHeadersSchema,
    pathParams: z.object({ botId: z.string().min(1) }),
    query: z.object({
      exp: z.string().optional(),
      sig: z.string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Proxy a Telegram bot avatar",
  },
  authCallback: {
    method: "GET",
    path: "/api/integrations/telegram/auth-callback",
    responses: {
      200: c.otherResponse({
        contentType: "text/html",
        body: z.unknown(),
      }),
    },
    summary: "Return the Telegram auth callback bridge page",
  },
  link: {
    method: "POST",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    body: telegramLinkBodySchema,
    responses: {
      200: telegramLinkResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link the authenticated VM0 user to a Telegram user",
  },
  register: {
    method: "POST",
    path: "/api/telegram/register",
    headers: authHeadersSchema,
    body: telegramRegisterBodySchema,
    responses: {
      200: telegramBotStatusSchema,
      201: telegramBotStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Register a Telegram bot with VM0",
  },
  setupStatus: {
    method: "POST",
    path: "/api/telegram/setup-status",
    headers: authHeadersSchema,
    body: telegramSetupStatusBodySchema,
    responses: {
      200: telegramSetupStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Check Telegram bot setup state before registration",
  },
});

export type ZeroIntegrationsTelegramContract =
  typeof zeroIntegrationsTelegramContract;
export type TelegramBot = z.infer<typeof telegramBotSchema>;
export type TelegramBotStatus = z.infer<typeof telegramBotStatusSchema>;
export type TelegramListResponse = z.infer<typeof telegramListResponseSchema>;
export type TelegramLinkStatusResponse = z.infer<
  typeof telegramLinkStatusResponseSchema
>;
export type TelegramSetupStatus = z.infer<typeof telegramSetupStatusSchema>;
