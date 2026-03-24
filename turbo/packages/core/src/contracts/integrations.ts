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
export const integrationsSlackMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/zero/integrations/slack/message",
    headers: authHeadersSchema,
    body: z.object({
      channel: z.string().min(1, "Channel ID is required"),
      text: z.string().optional(),
      threadTs: z.string().optional(),
      blocks: z.array(z.object({ type: z.string() }).passthrough()).optional(),
    }),
    responses: {
      200: z.object({
        ok: z.literal(true),
        ts: z.string().optional(),
        channel: z.string().optional(),
      }),
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
