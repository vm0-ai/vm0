import { z } from "zod";

import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";

export const githubDeliveryTargetSchema = z.object({
  installationId: z.string().uuid(),
  repo: z.string().min(1),
  subjectNumber: z.number().int().positive(),
  subjectKind: z.enum(["issue", "pull_request"]),
  agentId: z.string().uuid(),
  triggerCommentId: z.string().optional(),
  triggerReactionId: z.string().optional(),
  triggerCommentBody: z.string().optional(),
});

export type GitHubDeliveryTarget = z.infer<typeof githubDeliveryTargetSchema>;

export const githubChatCallbackPayloadSchema =
  githubDeliveryTargetSchema.extend({
    chatEventId: z.string().uuid(),
    publicBrand: publicBrandSchema,
  });
