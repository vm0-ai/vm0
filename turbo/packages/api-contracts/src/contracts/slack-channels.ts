import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * Slack channels contract (GET /api/okou/slack/channels)
 * Lists Slack channels where the bot is a member.
 */
export const slackChannelsContract = c.router({
  list: {
    method: "GET",
    path: "/api/okou/slack/channels",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ channels: z.array(slackChannelSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List Slack channels where bot is a member",
  },
});

export type SlackChannelsContract = typeof slackChannelsContract;
export type SlackChannel = z.infer<typeof slackChannelSchema>;
export { slackChannelSchema };
