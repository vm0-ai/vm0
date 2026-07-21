import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const feishuEnvironmentSchema = z.object({
  requiredSecrets: z.array(z.string()),
  requiredVars: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  missingVars: z.array(z.string()),
});

const feishuConnectStatusSchema = z.object({
  isInstalled: z.boolean(),
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  installUrl: z.string().nullable(),
  tenantKey: z.string().nullable(),
  tenantName: z.string().nullable(),
  defaultAgentName: z.string().nullable(),
  environment: feishuEnvironmentSchema,
});

export const zeroFeishuConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/integrations/feishu/connect",
    headers: authHeadersSchema,
    responses: {
      200: feishuConnectStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Check Feishu connection status",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/zero/integrations/feishu/connect",
    headers: authHeadersSchema,
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
