import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const feishuConnectStatusSchema = z.object({
  isInstalled: z.boolean(),
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  appId: z.string().nullable(),
  callbackUrl: z.string().nullable(),
  callbackVerified: z.boolean(),
  messageReceived: z.boolean(),
  tenantKey: z.string().nullable(),
  tenantName: z.string().nullable(),
  defaultAgentId: z.string().uuid().nullable(),
  defaultAgentName: z.string().nullable(),
});

export const zeroFeishuConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/integrations/feishu",
    headers: authHeadersSchema,
    responses: {
      200: feishuConnectStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Check Feishu connection status",
  },
  setup: {
    method: "POST",
    path: "/api/zero/integrations/feishu",
    headers: authHeadersSchema,
    body: z.object({
      appId: z.string().trim().min(1),
      appSecret: z.string().trim().min(1),
      verificationToken: z.string().trim().min(1),
      encryptKey: z.string().trim().min(1),
      defaultAgentId: z.string().uuid(),
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
    summary: "Remove a Feishu custom app",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/zero/integrations/feishu/connect",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a Feishu user",
  },
});

export type FeishuConnectStatus = z.infer<typeof feishuConnectStatusSchema>;
export type ZeroFeishuConnectContract = typeof zeroFeishuConnectContract;
