import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const slackOrgCallbackPayloadSchema = z
  .object({
    workspaceId: z.string(),
    channelId: z.string(),
    threadTs: z.string(),
    messageTs: z.string(),
    connectionId: z.string(),
    agentId: z.string(),
    existingSessionId: z.string().optional(),
  })
  .passthrough();

export const internalCallbacksSlackOrgContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/slack/org",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: slackOrgCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      500: internalCallbackErrorSchema,
      502: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for org Slack-triggered runs",
  },
});

export type SlackOrgCallbackPayload = z.infer<
  typeof slackOrgCallbackPayloadSchema
>;
export type InternalCallbacksSlackOrgContract =
  typeof internalCallbacksSlackOrgContract;
