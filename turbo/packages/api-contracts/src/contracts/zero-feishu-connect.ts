import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const feishuInstallationStatusSchema = z.object({
  id: z.string().uuid(),
  isConnected: z.boolean(),
  connectedUserName: z.string().nullable().optional(),
  appId: z.string(),
  botName: z.string().nullable().optional(),
  botAvatarUrl: z.string().nullable().optional(),
  callbackUrl: z.string(),
  oauthRedirectUrl: z.string().optional(),
  connectUrl: z.string().nullable().optional(),
  callbackVerified: z.boolean(),
  setupCompleted: z.boolean().optional(),
  messageReceived: z.boolean(),
  tenantKey: z.string().nullable(),
  tenantName: z.string().nullable(),
  defaultAgentId: z.string().uuid(),
  defaultAgentName: z.string().nullable(),
});

const feishuConnectStatusSchema = z.object({
  isInstalled: z.boolean(),
  isConnected: z.boolean(),
  connectedUserName: z.string().nullable().optional(),
  isAdmin: z.boolean(),
  appId: z.string().nullable(),
  botName: z.string().nullable().optional(),
  botAvatarUrl: z.string().nullable().optional(),
  callbackUrl: z.string().nullable(),
  oauthRedirectUrl: z.string().nullable().optional(),
  connectUrl: z.string().nullable().optional(),
  callbackVerified: z.boolean(),
  messageReceived: z.boolean(),
  tenantKey: z.string().nullable(),
  tenantName: z.string().nullable(),
  defaultAgentId: z.string().uuid().nullable(),
  defaultAgentName: z.string().nullable(),
  installationId: z.string().uuid().nullable().optional(),
  installations: z.array(feishuInstallationStatusSchema).optional(),
});

export const zeroFeishuConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/integrations/feishu",
    headers: authHeadersSchema,
    responses: {
      200: feishuConnectStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Check Feishu connection status",
  },
  checkAppId: {
    method: "GET",
    path: "/api/zero/integrations/feishu/app-id",
    headers: authHeadersSchema,
    query: z.object({
      appId: z.string().trim().min(1),
    }),
    responses: {
      200: z.object({ available: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Check whether a Feishu App ID is available",
  },
  setup: {
    method: "POST",
    path: "/api/zero/integrations/feishu",
    headers: authHeadersSchema,
    body: z.object({
      appId: z.string().trim().min(1),
      appSecret: z.string().trim().min(1),
      verificationToken: z.string().trim().min(1),
      encryptKey: z.string().trim().optional().default(""),
      defaultAgentId: z.string().uuid(),
      installationId: z.string().uuid().optional(),
      createNew: z.boolean().optional(),
    }),
    responses: {
      200: feishuConnectStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Configure a Feishu custom app",
  },
  updateInstallation: {
    method: "PATCH",
    path: "/api/zero/integrations/feishu/installations/:installationId",
    headers: authHeadersSchema,
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: z.object({
      defaultAgentId: z.string().uuid(),
      setupCompleted: z.boolean().optional(),
    }),
    responses: {
      200: feishuInstallationStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a Feishu custom app",
  },
  removeInstallation: {
    method: "DELETE",
    path: "/api/zero/integrations/feishu/installations/:installationId",
    headers: authHeadersSchema,
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall a Feishu custom app",
  },
  disconnectInstallation: {
    method: "DELETE",
    path: "/api/zero/integrations/feishu/installations/:installationId/connect",
    headers: authHeadersSchema,
    pathParams: z.object({ installationId: z.string().uuid() }),
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a Feishu user from a custom app",
  },
  remove: {
    method: "DELETE",
    path: "/api/zero/integrations/feishu",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Uninstall a Feishu custom app",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/zero/integrations/feishu/connect",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a Feishu user",
  },
});

export type FeishuConnectStatus = z.infer<typeof feishuConnectStatusSchema>;
export type FeishuInstallationStatus = z.infer<
  typeof feishuInstallationStatusSchema
>;
export type ZeroFeishuConnectContract = typeof zeroFeishuConnectContract;
