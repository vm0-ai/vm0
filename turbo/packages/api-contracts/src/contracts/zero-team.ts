import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { zeroAgentVisibilitySchema } from "./zero-agents";

const c = initContract();

const teamComposeItemSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  sound: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  customSkills: z.array(z.string()).optional(),
  visibility: zeroAgentVisibilitySchema.optional(),
  headVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

/**
 * Zero team contract (GET /api/zero/team)
 * Lists all agents in the user's active Clerk org.
 */
export const zeroTeamContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/team",
    headers: authHeadersSchema,
    responses: {
      200: z.array(teamComposeItemSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List all agents in the user's active org",
  },
});

export type ZeroTeamContract = typeof zeroTeamContract;
export type TeamComposeItem = z.infer<typeof teamComposeItemSchema>;
export { teamComposeItemSchema };
