import { z } from "zod";

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

export const githubChatCallbackPayloadSchema = z.preprocess(
  (payload) => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      "chatEventId" in payload ||
      !("chatMessageId" in payload)
    ) {
      return payload;
    }
    const { chatMessageId, ...target } = payload;
    return { ...target, chatEventId: chatMessageId };
  },
  githubDeliveryTargetSchema.extend({
    chatEventId: z.string().uuid(),
  }),
);
