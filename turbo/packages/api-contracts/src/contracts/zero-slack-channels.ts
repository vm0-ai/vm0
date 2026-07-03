import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * Zero Slack channels contract (GET /api/zero/slack/channels)
 * Lists Slack channels where the bot is a member.
 */
export const zeroSlackChannelsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/slack/channels",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ channels: z.array(slackChannelSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List Slack channels where bot is a member",
  },
});

export type ZeroSlackChannelsContract = typeof zeroSlackChannelsContract;
export type SlackChannel = z.infer<typeof slackChannelSchema>;
export { slackChannelSchema };
