import { z } from "zod";

export const githubIssuesCallbackPayloadSchema = z
  .object({
    installationId: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    agentId: z.string(),
    existingSessionId: z.string().optional(),
    sessionContinuityEnabled: z.boolean().optional(),
    triggerCommentId: z.string().optional(),
    triggerReactionId: z.string().optional(),
    triggerCommentBody: z.string().optional(),
  })
  .passthrough();

export type GitHubIssuesCallbackPayload = z.infer<
  typeof githubIssuesCallbackPayloadSchema
>;
