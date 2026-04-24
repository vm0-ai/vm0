import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const telegramEnvironmentSchema = z.object({
  requiredSecrets: z.array(z.string()),
  requiredVars: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  missingVars: z.array(z.string()),
});

const telegramBotSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  isOwner: z.boolean(),
  isConnected: z.boolean(),
});

const telegramBotStatusSchema = telegramBotSchema.extend({
  domainConfigured: z.boolean(),
  environment: telegramEnvironmentSchema,
});

const telegramListResponseSchema = z.object({
  bots: z.array(telegramBotSchema),
});

const telegramUpdateBodySchema = z.object({
  defaultAgentId: z.string().trim().min(1),
});

const telegramLinkStatusResponseSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(true), telegramUserId: z.string() }),
  z.object({
    linked: z.literal(false),
    installation: z
      .object({ id: z.string(), botUsername: z.string() })
      .optional(),
  }),
]);

const telegramRegisterBodySchema = z.object({
  botToken: z.string().min(1),
  defaultAgentId: z.string().trim().min(1).optional(),
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
    summary: "List Telegram bot integrations owned by the authenticated user",
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
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/telegram/link",
    headers: authHeadersSchema,
    query: z.object({ botId: z.string().optional() }),
    responses: {
      200: telegramLinkStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Check if the authenticated user is linked to a Telegram bot",
  },
  register: {
    method: "POST",
    path: "/api/telegram/register",
    headers: authHeadersSchema,
    body: telegramRegisterBodySchema,
    responses: {
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
});

export type ZeroIntegrationsTelegramContract =
  typeof zeroIntegrationsTelegramContract;
export type TelegramBot = z.infer<typeof telegramBotSchema>;
export type TelegramBotStatus = z.infer<typeof telegramBotStatusSchema>;
export type TelegramListResponse = z.infer<typeof telegramListResponseSchema>;
export type TelegramLinkStatusResponse = z.infer<
  typeof telegramLinkStatusResponseSchema
>;
