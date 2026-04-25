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

const telegramStatusResponseSchema = z.object({
  installationId: z.string(),
  bot: z.object({ id: z.string(), username: z.string() }),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  isAdmin: z.boolean(),
  isConnected: z.boolean(),
  domainConfigured: z.boolean(),
  environment: telegramEnvironmentSchema,
});

const telegramUpdateBodySchema = z.object({
  agentName: z.string().min(1),
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
  defaultAgentId: z.string().optional(),
});

const telegramRegisterResponseSchema = z.object({
  id: z.string(),
  botId: z.string(),
  botUsername: z.string(),
  webhookUrl: z.string(),
  domainConfigured: z.boolean(),
});

/**
 * Zero integrations Telegram contract
 * Covers all five Telegram integration endpoints.
 *
 * Path note: these endpoints use /api/integrations/ and /api/telegram/ (not /api/zero/)
 * because they are served by the platform app directly, not the Zero sub-application.
 * This is intentional and matches the real server routing.
 */
export const zeroIntegrationsTelegramContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/integrations/telegram",
    headers: authHeadersSchema,
    responses: {
      200: telegramStatusResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get Telegram bot integration status for the authenticated user",
  },
  update: {
    method: "PATCH",
    path: "/api/integrations/telegram",
    headers: authHeadersSchema,
    body: telegramUpdateBodySchema,
    responses: {
      200: z.object({ ok: z.boolean() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update the default agent for the Telegram bot",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/telegram",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall the Telegram bot (admin only)",
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
      201: telegramRegisterResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
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
export type TelegramStatusResponse = z.infer<
  typeof telegramStatusResponseSchema
>;
export type TelegramRegisterResponse = z.infer<
  typeof telegramRegisterResponseSchema
>;
export type TelegramLinkStatusResponse = z.infer<
  typeof telegramLinkStatusResponseSchema
>;
