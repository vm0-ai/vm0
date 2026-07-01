import { z } from "zod";

export const teamsOrgCallbackPayloadSchema = z
  .object({
    tenantId: z.string(),
    tenantName: z.string().nullable(),
    teamId: z.string().nullable(),
    teamName: z.string().nullable(),
    channelId: z.string().nullable(),
    conversationId: z.string(),
    conversationType: z.string().nullable(),
    threadId: z.string(),
    activityId: z.string().nullable(),
    serviceUrl: z.string(),
    connectionId: z.string(),
    teamsUserId: z.string(),
    teamsUserDisplayName: z.string().nullable(),
    teamsUserPrincipalName: z.string().nullable(),
    botId: z.string().nullable(),
    botName: z.string().nullable(),
    agentId: z.string(),
    existingSessionId: z.string().nullable(),
  })
  .passthrough();

export type TeamsOrgCallbackPayload = z.infer<
  typeof teamsOrgCallbackPayloadSchema
>;
