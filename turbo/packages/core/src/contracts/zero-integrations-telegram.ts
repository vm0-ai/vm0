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
});

const telegramOrgStatusSchema = z.object({
  isConnected: z.boolean(),
  isInstalled: z.boolean().optional(),
  isAdmin: z.boolean(),
  enabled: z.boolean().optional(),
  bot: telegramBotSchema.nullable().optional(),
  defaultAgentName: z.string().nullable().optional(),
  agentOrgSlug: z.string().nullable().optional(),
  domainConfigured: z.boolean().optional(),
  environment: telegramEnvironmentSchema.optional(),
});

const telegramAuthSchema = z.object({
  id: z.union([z.string(), z.number()]),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.union([z.string(), z.number()]),
  hash: z.string(),
});

const connectSignatureSchema = z.object({
  telegramUserId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

/**
 * Zero integrations Telegram contract
 * Manages org-scoped Telegram bot integration.
 */
export const zeroIntegrationsTelegramContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/integrations/telegram",
    headers: authHeadersSchema,
    responses: {
      200: telegramOrgStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Get org-scoped Telegram bot info",
  },
  install: {
    method: "POST",
    path: "/api/zero/integrations/telegram/install",
    headers: authHeadersSchema,
    body: z.object({
      botToken: z.string().min(1),
      telegramAuth: telegramAuthSchema,
    }),
    responses: {
      201: z.object({
        installationId: z.string(),
        bot: telegramBotSchema,
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Install Telegram bot for org (admin only)",
  },
  connect: {
    method: "POST",
    path: "/api/zero/integrations/telegram/connect",
    headers: authHeadersSchema,
    body: z.object({
      telegramAuth: telegramAuthSchema.optional(),
      connectSignature: connectSignatureSchema.optional(),
    }),
    responses: {
      200: z.object({
        botUsername: z.string().nullable(),
        telegramUserId: z.string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Connect user Telegram identity to org bot",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/integrations/telegram",
    headers: authHeadersSchema,
    body: z.object({
      enabled: z.boolean().optional(),
      agentName: z.string().optional(),
    }),
    responses: {
      200: z.object({ ok: z.boolean() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Toggle enabled state or change default agent (admin only)",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/zero/integrations/telegram",
    headers: authHeadersSchema,
    body: c.noBody(),
    query: z.object({
      action: z.string().optional(),
    }),
    responses: {
      200: z.object({ ok: z.boolean() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect user or uninstall Telegram bot",
  },
});

export type ZeroIntegrationsTelegramContract =
  typeof zeroIntegrationsTelegramContract;
export type TelegramOrgStatus = z.infer<typeof telegramOrgStatusSchema>;
export { telegramOrgStatusSchema };
