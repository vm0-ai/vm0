import { z } from "zod";

export const teamsOrgCallbackPayloadSchema = z
  .object({
    tenantId: z.string().min(1),
    tenantName: z.string().nullable(),
    teamId: z.string().nullable(),
    teamName: z.string().nullable(),
    channelId: z.string().nullable(),
    conversationId: z.string().min(1),
    conversationType: z.string().nullable(),
    threadId: z.string().min(1),
    activityId: z.string().nullable(),
    serviceUrl: z.string(),
    connectionId: z.string().min(1),
    teamsUserId: z.string().min(1),
    teamsUserDisplayName: z.string().nullable(),
    teamsUserPrincipalName: z.string().nullable(),
    botId: z.string().nullable(),
    botName: z.string().nullable(),
    agentId: z.string().min(1),
    existingSessionId: z.string().nullable(),
  })
  .passthrough();

export type TeamsOrgCallbackPayload = z.infer<
  typeof teamsOrgCallbackPayloadSchema
>;
