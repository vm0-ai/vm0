import { z } from "zod";

import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const githubIssuesCallbackPayloadSchema = z
  .object({
    installationId: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    agentId: z.string(),
    existingSessionId: z.string().optional(),
    triggerCommentId: z.string().optional(),
    triggerReactionId: z.string().optional(),
    triggerCommentBody: z.string().optional(),
  })
  .passthrough();

export const internalCallbacksGithubIssuesContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/github/issues",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema.extend({
      payload: githubIssuesCallbackPayloadSchema,
    }),
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
      500: internalCallbackErrorSchema,
    },
    summary: "Handle callbacks for GitHub issue-triggered runs",
  },
});

export type GitHubIssuesCallbackPayload = z.infer<
  typeof githubIssuesCallbackPayloadSchema
>;
export type InternalCallbacksGithubIssuesContract =
  typeof internalCallbacksGithubIssuesContract;
