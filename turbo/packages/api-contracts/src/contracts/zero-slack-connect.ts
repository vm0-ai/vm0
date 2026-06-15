import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackConnectStatusSchema = z.object({
  isConnected: z.boolean(),
  isAdmin: z.boolean(),
  workspaceName: z.string().nullable().optional(),
  defaultAgentName: z.string().nullable().optional(),
});

const slackConnectResponseSchema = z.object({
  success: z.boolean(),
  connectionId: z.string(),
  role: z.string(),
});

/**
 * Zero Slack connect contract (GET/POST /api/zero/integrations/slack/connect)
 * Manages per-user Slack connection.
 */
export const zeroSlackConnectContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/integrations/slack/connect",
    headers: authHeadersSchema,
    responses: {
      200: slackConnectStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Check user Slack connection status",
  },
  connect: {
    method: "POST",
    path: "/api/zero/integrations/slack/connect",
    headers: authHeadersSchema,
    body: z.object({
      workspaceId: z.string().min(1),
      slackUserId: z.string().min(1),
      channelId: z.string().optional(),
      threadTs: z.string().optional(),
    }),
    responses: {
      200: slackConnectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Connect user to Slack workspace",
  },
});

export type ZeroSlackConnectContract = typeof zeroSlackConnectContract;
