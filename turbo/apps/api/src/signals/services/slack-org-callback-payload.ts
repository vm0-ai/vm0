import { z } from "zod";

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

export type SlackOrgCallbackPayload = z.infer<
  typeof slackOrgCallbackPayloadSchema
>;
