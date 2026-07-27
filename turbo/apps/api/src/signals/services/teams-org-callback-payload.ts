import { z } from "zod";

import { teamsDeliveryTargetSchema } from "./teams-chat-callback-payload";

export const teamsOrgCallbackPayloadSchema = z
  .object({
    agentId: z.string().min(1),
    existingSessionId: z.string().nullable(),
    canonicalChatDelivery: z.boolean().optional(),
  })
  .extend(teamsDeliveryTargetSchema.shape)
  .passthrough();

export type TeamsOrgCallbackPayload = z.infer<
  typeof teamsOrgCallbackPayloadSchema
>;
